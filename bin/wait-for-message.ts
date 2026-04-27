#!/usr/bin/env -S npx tsx

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type Channel = { id: string, name: string, type: 'O' | 'P' | 'D' | 'G' }

type Post = {
  id: string,
  user_id: string,
  channel_id: string,
  message: string,
  create_at: number,
  type: string,
  root_id: string,
}

const AGENT = process.argv[2]

if (!AGENT) {
  process.stderr.write('usage: wait-for-message <agent-name>\n')
  process.exit(2)
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')

const MM_URL = process.env.MM_URL || 'http://localhost:8065'
const WS_URL = MM_URL.replace(/^http/, 'ws') + '/api/v4/websocket'
const TEAM_NAME = process.env.MM_TEAM_NAME || 'workspace'
const TIMEOUT_MS = parseInt(process.env.WAIT_TIMEOUT_MS ?? String(9 * 60 * 1000), 10)
const AGENT_DIR = path.join(ROOT, 'agents', AGENT)
const TOKEN_FILE = path.join(AGENT_DIR, 'token')
const CURSOR_FILE = path.join(AGENT_DIR, 'last-seen.json')

async function readAgentToken(): Promise<string> {
  try {
    return (await fs.readFile(TOKEN_FILE, 'utf8')).trim()
  } catch {
    throw new Error(`no token at ${TOKEN_FILE} — is agent '${AGENT}' provisioned?`)
  }
}

async function api<T>(token: string, pathname: string): Promise<T> {
  const response = await fetch(`${MM_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) throw new Error(`${pathname}: ${response.status}`)

  return response.json() as Promise<T>
}

async function readCursor(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await fs.readFile(CURSOR_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function writeCursor(cursor: Record<string, number>): Promise<void> {
  await fs.mkdir(AGENT_DIR, { recursive: true })
  await fs.writeFile(CURSOR_FILE, JSON.stringify(cursor, null, 2))
}

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n')
}

async function main(): Promise<void> {
  const token = await readAgentToken()
  const team = await api<{ id: string }>(token, `/api/v4/teams/name/${TEAM_NAME}`)
  const channels = await api<Channel[]>(token, `/api/v4/users/me/teams/${team.id}/channels`)
  const channelIds = new Set(channels.map((channel) => channel.id))
  const channelById = new Map(channels.map((channel) => [channel.id, channel]))
  const cursor = await readCursor()
  const now = Date.now()

  let cursorChanged = false

  for (const id of channelIds) {
    if (cursor[id] == null) {
      cursor[id] = now
      cursorChanged = true
    }
  }

  if (cursorChanged) await writeCursor(cursor)

  for (const id of channelIds) {
    const since = cursor[id] ?? 0
    const data = await api<{ posts?: Record<string, Post> }>(token, `/api/v4/channels/${id}/posts?since=${since}`)

    if (!data?.posts) continue

    const posts = Object.values(data.posts)
      .filter((post) => post.create_at > since && post.type === '')
      .sort((a, b) => a.create_at - b.create_at)

    if (posts.length === 0) continue

    const post = posts[0]
    const channel = channelById.get(id)

    cursor[id] = post.create_at
    await writeCursor(cursor)

    emit({
      source: 'rest',
      channel: { id, name: channel?.name, type: channel?.type },
      post,
    })

    return
  }

  const socket = new WebSocket(WS_URL)

  let resolved = false

  const timer = setTimeout(() => {
    if (resolved) return
    resolved = true

    try { socket.close() } catch {}

    emit({ timeout: true, waited_ms: TIMEOUT_MS })
    process.exit(0)
  }, TIMEOUT_MS)

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      seq: 1,
      action: 'authentication_challenge',
      data: { token },
    }))
  })

  socket.addEventListener('message', async (event) => {
    if (resolved) return

    let parsed: { event?: string, data?: { post?: string } }

    try { parsed = JSON.parse(event.data as string) } catch { return }

    if (parsed.event !== 'posted' || !parsed.data?.post) return

    let post: Post

    try { post = JSON.parse(parsed.data.post) } catch { return }

    if (!channelIds.has(post.channel_id)) return
    if (post.type !== '') return

    resolved = true
    clearTimeout(timer)
    cursor[post.channel_id] = post.create_at
    await writeCursor(cursor)

    try { socket.close() } catch {}

    const channel = channelById.get(post.channel_id)

    emit({
      source: 'ws',
      channel: { id: post.channel_id, name: channel?.name, type: channel?.type },
      post,
    })

    process.exit(0)
  })

  socket.addEventListener('error', (error) => {
    if (resolved) return

    resolved = true
    clearTimeout(timer)
    process.stderr.write(JSON.stringify({ error: String((error as Event).type || error) }) + '\n')
    process.exit(1)
  })
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n')
  process.exit(1)
})
