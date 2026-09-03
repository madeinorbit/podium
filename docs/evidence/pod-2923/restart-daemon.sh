#!/usr/bin/env bash
# Restart only the named-rig daemon while preserving the supported Codex PATH.
# This helper does not re-source drive-env.sh, which would put Codex 0.150.1 first.
set -euo pipefail

: "${PODIUM_DRIVE_BASE:?PODIUM_DRIVE_BASE is required}"
: "${PODIUM_DRIVE_REPO:?PODIUM_DRIVE_REPO is required}"

LOGS="$PODIUM_DRIVE_BASE/logs"
PIDFILE="$PODIUM_DRIVE_BASE/daemon.pid"
OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
case "$OLD" in
  ''|*[!0-9]*) echo "invalid daemon pid: $OLD" >&2; exit 2 ;;
esac

echo "OLD_DAEMON_PID=$OLD"
kill "$OLD" 2>/dev/null || true
for _ in $(seq 1 60); do
  if ! kill -0 "$OLD" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -9 "$OLD" 2>/dev/null || true
if kill -0 "$OLD" 2>/dev/null; then
  echo "old daemon $OLD would not die" >&2
  exit 3
fi

BEFORE_LINES="$(wc -l < "$LOGS/daemon.log")"
CODEX_BIN_DIR="${PODIUM_CODEX_BIN_DIR:-/home/mgw/.codex/packages/standalone/releases/0.149.1-x86_64-unknown-linux-musl/bin}"
export PATH="$CODEX_BIN_DIR:$PATH"
export PODIUM_WEB_DIR="$PODIUM_DRIVE_REPO/apps/web/dist"
cd "$PODIUM_DRIVE_REPO"
nohup bun --conditions=@podium/source scripts/daemon.ts >>"$LOGS/daemon.log" 2>&1 &
NEW="$!"
echo "$NEW" > "$PIDFILE"
git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD > "$PODIUM_DRIVE_BASE/daemon.sha"
echo "NEW_DAEMON_PID=$NEW"
echo "CODEX_BIN_DIR=$CODEX_BIN_DIR"

for _ in $(seq 1 120); do
  if ! kill -0 "$NEW" 2>/dev/null; then
    echo "new daemon $NEW exited" >&2
    exit 4
  fi
  if tail -n +$((BEFORE_LINES + 1)) "$LOGS/daemon.log" | grep -q "podium daemon up: connected"; then
    echo "DAEMON_RECONNECTED=1"
    exit 0
  fi
  sleep 1
done
echo "DAEMON_RECONNECTED=0" >&2
exit 5
