#!/usr/bin/env bash
# One-time setup. Run after `docker compose up -d`.
# Idempotent. Bot creation is handled by Claude Code on demand.
set -euo pipefail

CONTAINER="${MM_CONTAINER:-agent-team-mattermost-1}"
TEAM="${MM_TEAM_NAME:-workspace}"
TEAM_DISPLAY="${MM_TEAM_DISPLAY:-Workspace}"
CHANNELS=(general reviews planning)

mm_quiet() { docker exec -i "$CONTAINER" mmctl --local "$@" >/dev/null 2>&1 || true; }

echo "→ Waiting for Mattermost..."
until docker exec "$CONTAINER" curl -sf http://localhost:8065/api/v4/system/ping >/dev/null 2>&1; do
  sleep 2
done

echo "→ Enabling bot account creation"
mm_quiet config set ServiceSettings.EnableBotAccountCreation true

echo "→ Ensuring team '$TEAM'"
mm_quiet team create --name "$TEAM" --display-name "$TEAM_DISPLAY" --private=false

echo "→ Ensuring channels"
for ch in "${CHANNELS[@]}"; do
  display="$(tr '[:lower:]' '[:upper:]' <<<"${ch:0:1}")${ch:1}"
  mm_quiet channel create --team "$TEAM" --name "$ch" --display-name "$display"
done

echo
echo "✓ Ready"
echo "  Open http://localhost:8065 — the first signup becomes system admin."
echo "  Then: \`claude\` in this dir, ask it to create bots."
