#!/usr/bin/env bash
# Restart only the p3112-oc-paired-r2 daemon, keeping the same spawn SHA.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
PIDFILE="$PODIUM_DRIVE_BASE/daemon.pid"
OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
[ -n "$OLD" ] || { echo "no daemon.pid — bring the rig up first" >&2; exit 2; }
HEAD_SHA="$(cat "$PODIUM_DRIVE_BASE/daemon.sha")"
export PODIUM_WEB_DIR="$PODIUM_DRIVE_REPO/apps/web/dist"

echo "OLD_DAEMON_PID=$OLD"
kill "$OLD" 2>/dev/null || true
for _ in $(seq 1 60); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.25; done
kill -9 "$OLD" 2>/dev/null || true
kill -0 "$OLD" 2>/dev/null && { echo "old daemon $OLD would not die" >&2; exit 3; }

cd "$PODIUM_DRIVE_REPO"
nohup setsid env \
  PODIUM_INSTANCE="$PODIUM_INSTANCE" \
  PODIUM_PORT="$PODIUM_PORT" \
  PODIUM_HOOK_PORT="$PODIUM_HOOK_PORT" \
  PODIUM_AGENT_RELAY_PORT="$PODIUM_AGENT_RELAY_PORT" \
  PODIUM_PASSWORD="$PODIUM_PASSWORD" \
  PODIUM_NO_RELAY=1 \
  PODIUM_SPAWN_SHA="$HEAD_SHA" \
  PODIUM_WEB_DIR="$PODIUM_WEB_DIR" \
  OPENCODE_BIN="$P3112_OPENCODE_BIN" \
  PODIUM_RUNTIME_CONTRACT="$PODIUM_RUNTIME_CONTRACT" \
  PODIUM_CHAT_STREAMING="$PODIUM_CHAT_STREAMING" \
  PODIUM_LOG_LEVEL=debug \
  PATH="$PATH" \
  bun --conditions=@podium/source scripts/daemon.ts \
  >>"$LOGS/daemon.log" 2>&1 < /dev/null &
NEW=$!
echo "$NEW" > "$PIDFILE"
printf '%s\n' "$HEAD_SHA" > "$PODIUM_DRIVE_BASE/daemon.sha"
for _ in $(seq 1 80); do
  if grep -q "podium daemon up: connected to" <(tail -n 40 "$LOGS/daemon.log"); then
    echo "NEW_DAEMON_PID=$NEW sha=$HEAD_SHA"
    exit 0
  fi
  sleep 0.25
done
echo "new daemon $NEW did not announce connected" >&2
exit 4
