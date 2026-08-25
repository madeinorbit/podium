#!/usr/bin/env bash
# Stop the `p2801` pair and every session it spawned. Leaves the state root.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
for name in daemon server; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$(cat "$pidfile")" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$(cat "$pidfile")" 2>/dev/null || true
    echo "stopped $name"
  fi
  rm -f "$pidfile"
done
# The agents themselves live in abduco sessions under this rig's OWN socket dir,
# so this cannot reach another instance's terminals.
if command -v abduco >/dev/null 2>&1; then
  abduco 2>/dev/null | tail -n +2 | awk '{print $NF}' | while read -r s; do
    [ -n "$s" ] && abduco -A "$s" true >/dev/null 2>&1 || true
  done
fi
pkill -f "ABDUCO_SOCKET_DIR=$ABDUCO_SOCKET_DIR" 2>/dev/null || true
echo "instance '$PODIUM_INSTANCE' down"
