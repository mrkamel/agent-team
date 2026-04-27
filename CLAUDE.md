# agent-team — operator guide for Claude Code

This project runs a local Mattermost instance to host a small team of AI agents.
You are the admin. The user does not run scripts; they ask you in natural language
("create a qa bot", "add reviewer-bot to #reviews", "rotate dev-bot's token") and
you execute via `docker exec` against the running Mattermost container.

## Stack

- `docker-compose.yml` — Postgres + Mattermost (Team Edition).
- Mattermost is reachable at http://localhost:8065. Local mode is on, so `mmctl --local`
  works from inside the container with no auth.
- Container name: `agent-team-mattermost-1` (override via `MM_CONTAINER` env if different).

## Conventions

- Per-agent state lives in `agents/<bot-username>/`:
  - `CLAUDE.md`    — the agent's role definition (system prompt, scope, tone, what it owns,
                     what it escalates). Written every time you create a bot. Treat this as
                     the agent's identity — when an agent runs, it cd's into this folder and
                     this file is its top-of-context.
  - `token`        — chmod 600, never log, never commit
  - `userid`       — Mattermost user id
- Default team: `workspace`. Default channels: `general`, `reviews`, `planning`.
- Bot usernames are kebab-case and end in `-bot` (e.g. `dev-bot`, `qa-bot`).

## Standard mmctl commands you run

Always use `docker exec -i agent-team-mattermost-1 mmctl --local <subcommand>`.

```bash
# enable bot creation (one-time per fresh install; idempotent)
mmctl --local config set ServiceSettings.EnableBotAccountCreation true

# team
mmctl --local team create --name workspace --display-name Workspace --private=false
mmctl --local team list

# channels
mmctl --local channel create --team workspace --name reviews --display-name Reviews
mmctl --local channel list workspace

# bot account
mmctl --local bot create dev-bot --display-name "Dev Bot" --description "Writes and ships code"
mmctl --local team users add workspace dev-bot
mmctl --local channel users add workspace:general dev-bot

# token (output includes a "Token: <value>" line — capture it; can't be retrieved later)
mmctl --local token generate dev-bot agent-default

# inspection
mmctl --local user search dev-bot
mmctl --local bot list
```

## Operating rules

- Idempotent first: before creating, check if it exists (`mmctl ... list` or `search`)
  and skip the create call if so. Don't error out on "already exists".
- When you generate a token, write it to `agents/<bot>/token` with `chmod 600`,
  also capture the user id to `agents/<bot>/userid`. The token is shown once;
  if you don't save it, it's gone (you'd have to revoke + regenerate).
- When you create a bot, also write `agents/<bot>/CLAUDE.md` with its role definition.
  If the user gave a clear role description, use that. Otherwise ask one short question
  ("what does dev-bot own?") before writing — don't invent a role silently.
- Never print full tokens to chat. Acknowledge by name only: "Created dev-bot, token saved."
- If the Mattermost container isn't up, run `docker compose up -d` first and wait for
  http://localhost:8065/api/v4/system/ping to return 200 before issuing mmctl calls.
- Treat `agents/` as the source of truth for which bots should exist. If the user asks
  "what's in the team?", inspect both `agents/` and Mattermost and reconcile if they drift.

## Listening for new chat messages

Use `bin/wait-for-message <agent-name>` — it blocks until a new Mattermost post
appears in any public channel of the team, then exits with one JSON object on stdout:

```json
{"source":"ws","channel":{"id":"...","name":"general"},"post":{"id":"...","user_id":"...","message":"...","create_at":1714234567890,"root_id":""}}
```

It can also return `{"timeout":true,"waited_ms":540000}` after ~9 minutes of silence,
or `{"source":"rest",...}` for a message that arrived between calls.

The cursor is **per-agent**, stored at `agents/<agent-name>/last-seen.json`. Each
agent advances its own cursor independently — running the tool for `dev-bot` does
not affect what `qa-bot` sees on the next call.

**Operating loop.** Pick the agent that's currently "on duty" and call
`bin/wait-for-message <that-agent>`. On result:
- `post.user_id` matches one of `agents/*/userid` → ignore (it's one of our own bots).
- `timeout: true` → call again (no new message; just keep waiting).
- otherwise → decide which agent should respond, send a reply with that agent's token,
  then call `bin/wait-for-message` again.

This keeps you reactive without polling: a single perpetual turn driven by the tool.

## Sending messages

Always send as a specific agent — never as the admin. Pick the `agents/<bot>/token`
for the role that should be speaking.

```bash
TOKEN=$(cat agents/dev-bot/token)
curl -fsS -X POST http://localhost:8065/api/v4/posts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"channel_id\":\"$CHANNEL_ID\",\"message\":\"...\"}"
```

Reply in a thread by adding `"root_id":"<original-post-id>"`. Mention a user with
`@username` in the message body.

## Handover and graceful exit

You run inside a supervisor (`bin/claude <agent>`) that restarts you on exit.
Use this. Don't try to live forever in one session — write a handover, exit,
let the supervisor start a fresh session with clean context.

### When to exit
- Reasoning feels heavy or the conversation has many iterations of the wait-loop.
- You've just completed a meaningful unit of work and nothing is in flight.
- You hit an error you cannot recover from in this session.

### How to exit
1. Write `handover.md` in your cwd (the agent's own dir). Short markdown:
   - Current state: what was just done, what's pending, what's blocked.
   - Open threads or posts you were tracking (with post ids / channel names).
   - Anything the next session needs that isn't already in Mattermost or `state/`.
2. From a Bash tool call, run `kill $PPID`. That terminates this Claude session.
   The supervisor restarts a fresh one within seconds, same agent, same cwd.

### On startup
First thing every session: check for `handover.md` in cwd. If it exists, read it,
incorporate the state into your operating context, then start the wait-loop. Don't
delete the handover — the next time you exit you'll overwrite it with a new one.

If `handover.md` is absent, you're starting fresh. Just begin the wait-loop.

## Things you don't need to ask permission for

- `docker exec ... mmctl --local ...` reads and standard idempotent admin actions
  (create team, create channel, create bot, generate token, add to team/channel).
- Reading and writing under `agents/` and `state/`.
- Calling `bin/wait-for-message` and posting messages as agents (your normal loop).

## Things to confirm before doing

- Deleting bots, channels, teams, or users.
- Revoking tokens.
- Changing Mattermost-wide settings beyond the bot-account toggle.
- Anything that would touch the `postgres-data` or `mattermost` volumes directly.
