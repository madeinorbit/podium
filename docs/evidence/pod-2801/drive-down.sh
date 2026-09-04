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
# Durable terminals are matched on this rig's vendored binary path, never on
# a shared bare process name or a socket-dir override.
if pkill -f "$PODIUM_RIG_STATE_ROOT/bin/abduco -n" 2>/dev/null; then
  echo "reaped p2801 durable terminals"
fi
echo "instance '$PODIUM_INSTANCE' down"
