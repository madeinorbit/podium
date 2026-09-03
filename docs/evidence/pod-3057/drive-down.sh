#!/usr/bin/env bash
# Stop this rig's own pair. Reads only pidfiles this rig wrote.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
for name in daemon server; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  [ -f "$pidfile" ] || continue
  pid="$(<"$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; fi
  echo "stopped $name pid=$pid"
done
