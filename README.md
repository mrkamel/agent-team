# agent-team

Local-first AI agent workforce. Each agent is its own Claude Code session running
in `agents/<name>/`, talking to the others through a self-hosted Mattermost.
State on disk, supervisor restarts on exit, no cloud.

## Prerequisites

- Docker + Docker Compose
- Node 22+
- `claude` (Claude Code) on PATH

## Setup

```bash
cp .env.example .env       # adjust admin password etc. before first boot
npm install
docker compose up -d
```

The init container creates the admin user, team `workspace`, and channels
`general`, `reviews`, `planning`.

Open http://localhost:8065 → log in with the values from your `.env`
(default `admin` / `changeme123!`).

## Create a bot

You create team bots simply with a claude session. Therefore, start:

```bash
claude
```

In the session: *"create a dev-bot."* The orchestrator runs the right `mmctl`
commands, captures the token, writes `agents/dev-bot/{token,userid,CLAUDE.md}`,
and adds the bot to the team channels.

## Run an agent

```bash
./bin/claude dev-bot
```

The supervisor cd's into `agents/dev-bot/`, spawns an interactive Claude session
with `--permission-mode auto`, kicks it off with a default prompt that starts
the wait-loop. Type into the session to talk to the agent; it also listens for
Mattermost messages and replies as `dev-bot`.

When Claude exits (self-kill via `kill $PPID`, `/exit`, or crash), the supervisor
prints a summary and starts a fresh session — same agent, same cwd, clean
context. `agents/<name>/handover.md` carries continuity across the restart.

## Layout

```
docker-compose.yml      postgres + mattermost + one-shot init
init-mattermost.ts      admin/team bootstrap (runs in init container)
.env                    creds, team name
CLAUDE.md               operator handbook — loaded by every session
CODE_STYLE.md           style rules for any code in this repo
bin/
  claude(.ts)           restart loop, spawns interactive Claude
  wait-for-message(.ts) blocks until next chat message (per-agent cursor)
agents/<bot>/
  CLAUDE.md             role definition (loaded as cwd CLAUDE.md)
  token, userid         Mattermost credentials
  last-seen.json        wait-for-message cursor
  handover.md           written before self-exit, read on next start
  init-prompt.md        optional override for supervisor's kick-off prompt
state/                  shared cross-agent state
```

## How it works

- Each agent is a separate Claude Code session running in `agents/<name>/`.
- `bin/wait-for-message <agent>` blocks until a new post arrives in any channel
  the agent is in (DMs and group DMs included), advances the cursor, exits.
- Claude decides who should respond, posts back via `curl` with the matching
  bot token, calls `wait-for-message` again — one perpetual reactive turn.
- When context gets heavy, Claude writes `handover.md` and `kill $PPID`s. The
  supervisor restarts. Fresh session, same disk state.
- Mattermost is the chat history, `state/` and `agents/<name>/` are the durable
  memory. Sessions are disposable.
