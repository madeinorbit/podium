#!/usr/bin/env bash
# Restart only the daemon. The server and client socket remain up for A7a.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
<<<<<<< HEAD
REPO="$(cd "$HERE/../../.." && pwd)"
source "$HERE/drive-env.sh"
: "${P2919_CODE_PIN:?P2919_CODE_PIN must name the immutable rig pin}"
=======
REPO="$(cd "$HERE/../.." && pwd)"
source "$HERE/drive-env.sh"
>>>>>>> fd5cc091a (docs(evidence): add opencode ten-cell drive)

pidfile="$PODIUM_DRIVE_BASE/daemon.pid"
old="$(cat "$pidfile")"
kill "$old" 2>/dev/null || true
for _ in $(seq 1 80); do
  if ! kill -0 "$old" 2>/dev/null; then break; fi
  sleep 0.25
done
kill -9 "$old" 2>/dev/null || true
rm -f "$pidfile"

nohup bun --conditions=@podium/source "$REPO/scripts/daemon.ts" \
  >"$PODIUM_DRIVE_BASE/logs/daemon.log" 2>&1 &
new="$!"
echo "$new" >"$pidfile"
<<<<<<< HEAD
printf "%s\n" "$P2919_CODE_PIN" >"$PODIUM_DRIVE_BASE/daemon.sha"
=======
git -C "$REPO" rev-parse HEAD >"$PODIUM_DRIVE_BASE/daemon.sha"
>>>>>>> fd5cc091a (docs(evidence): add opencode ten-cell drive)

reconnected=0
for _ in $(seq 1 120); do
  if curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 \
    && kill -0 "$new" 2>/dev/null; then
    reconnected=1
    break
  fi
  sleep 1
done
echo "OLD_DAEMON_PID=$old"
echo "NEW_DAEMON_PID=$new"
echo "DAEMON_RECONNECTED=$reconnected"
[ "$reconnected" = 1 ]
