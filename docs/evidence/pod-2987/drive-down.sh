#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/drive-env.sh"

for name in daemon server; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  if [ -f "$pidfile" ]; then
    pid="$(<"$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    fi
  fi
done

CREDENTIAL="$PODIUM_RIG_STATE_ROOT/agent-home/.claude/.credentials.json"
if [ -f "$CREDENTIAL" ]; then rm -- "$CREDENTIAL"; fi
if [ -e "$CREDENTIAL" ]; then
  echo "credential cleanup failed: $CREDENTIAL still exists" >&2
  exit 1
fi
echo "stopped exact rig processes; isolated credential copy removed"
