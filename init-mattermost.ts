type LoginHeaders = { Token: string }

const MM = 'http://mattermost:8065'
const MM_ADMIN_EMAIL = process.env.MM_ADMIN_EMAIL!
const MM_ADMIN_USERNAME = process.env.MM_ADMIN_USERNAME!
const MM_ADMIN_PASSWORD = process.env.MM_ADMIN_PASSWORD!
const MM_TEAM_NAME = process.env.MM_TEAM_NAME!

async function waitForMattermost(): Promise<void> {
  console.log('→ Waiting for Mattermost HTTP on 8065...')

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${MM}/api/v4/system/ping`)

      if (response.ok) {
        console.log('  ready')
        return
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  throw new Error('Mattermost did not become reachable in 120s')
}

async function createAdmin(): Promise<void> {
  console.log('→ Creating admin (idempotent — first signup becomes system admin)')

  const response = await fetch(`${MM}/api/v4/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: MM_ADMIN_EMAIL,
      username: MM_ADMIN_USERNAME,
      password: MM_ADMIN_PASSWORD,
    }),
  })

  if (!response.ok) console.log('  (admin already exists)')
}

async function login(): Promise<string> {
  console.log('→ Logging in')

  const response = await fetch(`${MM}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login_id: MM_ADMIN_USERNAME,
      password: MM_ADMIN_PASSWORD,
    }),
  })

  if (!response.ok) throw new Error(`login failed: ${response.status}`)

  const token = response.headers.get('Token')

  if (!token) throw new Error('login: no Token header')

  return token
}

async function enableBots(token: string): Promise<void> {
  console.log('→ Enabling bot account creation')

  const response = await fetch(`${MM}/api/v4/config/patch`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ServiceSettings: { EnableBotAccountCreation: true } }),
  })

  if (!response.ok) throw new Error(`enable bots failed: ${response.status}`)
}

async function ensureTeam(token: string): Promise<void> {
  console.log(`→ Ensuring team '${MM_TEAM_NAME}'`)

  const response = await fetch(`${MM}/api/v4/teams`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: MM_TEAM_NAME,
      display_name: MM_TEAM_NAME,
      type: 'O',
    }),
  })

  if (!response.ok) console.log('  (team already exists)')
}

await waitForMattermost()
await createAdmin()
const token = await login()
await enableBots(token)
await ensureTeam(token)

console.log(`✓ Init complete — login at ${MM} with ${MM_ADMIN_USERNAME} / ${MM_ADMIN_PASSWORD}`)
