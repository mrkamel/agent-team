import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const AGENT = process.argv[2]

if (!AGENT) {
  process.stderr.write('usage: claude <agent-name>\n')
  process.exit(2)
}

const AGENT_DIR = path.join(ROOT, 'agents', AGENT)

if (!fs.existsSync(AGENT_DIR)) {
  process.stderr.write(`[supervisor] agent dir not found: ${AGENT_DIR}\n`)
  process.exit(1)
}

const MIN_SLEEP = parseInt(process.env.MIN_SLEEP || '2', 10)
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'auto'
const INIT_PROMPT_FILE = path.join(AGENT_DIR, 'init-prompt.md')

function readInitPrompt(): string {
  if (process.env.PROMPT) return process.env.PROMPT

  try {
    return fs.readFileSync(INIT_PROMPT_FILE, 'utf8').trim()
  } catch {
    return `You are ${AGENT}. Read CLAUDE.md for your role and operating rules, then start your duty loop: call bin/wait-for-message ${AGENT}, handle the result, repeat.`
  }
}

const PROMPT = readInitPrompt()

function findRealClaude(): string {
  for (const candidate of (process.env.PATH || '').split(':')) {
    if (!candidate || candidate === SCRIPT_DIR) continue

    const binary = path.join(candidate, 'claude')

    try {
      fs.accessSync(binary, fs.constants.X_OK)
      return binary
    } catch {}
  }

  throw new Error(`real claude binary not found on PATH (excluding ${SCRIPT_DIR})`)
}

const REAL_CLAUDE = findRealClaude()

let stop = false

process.on('SIGINT', () => { stop = true })
process.on('SIGTERM', () => { stop = true })

let iteration = 0

while (!stop) {
  iteration++

  const startTime = Date.now()

  console.log(`[supervisor:${AGENT}] starting session #${iteration} at ${new Date().toISOString()} (${REAL_CLAUDE})`)

  const args = ['--permission-mode', PERMISSION_MODE]

  if (PROMPT) args.push(PROMPT)

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(REAL_CLAUDE, args, {
      cwd: AGENT_DIR,
      stdio: 'inherit',
    })

    child.on('exit', (code) => resolve(code ?? 0))
    child.on('error', (error) => {
      console.error(`[supervisor:${AGENT}] spawn error: ${error.message}`)
      resolve(1)
    })
  })

  const duration = Math.floor((Date.now() - startTime) / 1000)

  console.log(`[supervisor:${AGENT}] session #${iteration} exited (code=${exitCode}, ran ${duration}s)`)

  if (stop) break

  const backoff = duration < MIN_SLEEP ? MIN_SLEEP * 2 : MIN_SLEEP

  if (duration < MIN_SLEEP) console.log(`[supervisor:${AGENT}] short-lived session, backing off ${backoff}s`)

  await new Promise((resolve) => setTimeout(resolve, backoff * 1000))
}
