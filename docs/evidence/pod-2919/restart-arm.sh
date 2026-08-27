#!/usr/bin/env bash
# Restart the server and daemon for the explicit A10 arm switch.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
source "$HERE/drive-env.sh"

stop_one() {
  local name="$1" file="$PODIUM_DRIVE_BASE/$1.pid"
  if [ -f "$file" ]; then
    local pid
    pid="$(cat "$file")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 80); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 0.25
    done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$file"
  fi
}
stop_one daemon
stop_one server

start_one() {
  local name="$1" script="$2"
  nohup bun --conditions=@podium/source "$REPO/$script" \
    >"$PODIUM_DRIVE_BASE/logs/$name.log" 2>&1 &
  local pid="$!"
  echo "$pid" >"$PODIUM_DRIVE_BASE/$name.pid"
  git -C "$REPO" rev-parse HEAD >"$PODIUM_DRIVE_BASE/$name.sha"
  echo "STARTED_${name^^}_PID=$pid"
}

start_one server scripts/server.ts
for _ in $(seq 1 120); do
  if curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1
start_one daemon scripts/daemon.ts
for _ in $(seq 1 120); do
  if kill -0 "$(cat "$PODIUM_DRIVE_BASE/daemon.pid")" 2>/dev/null; then break; fi
  sleep 1
done
echo "ARM_RESTARTED=1"
