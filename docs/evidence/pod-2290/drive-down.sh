#!/usr/bin/env bash
# Stop the `p2290` instance. `--purge` also deletes its state root.
#
#   bash docs/evidence/pod-2290/drive-down.sh
#   bash docs/evidence/pod-2290/drive-down.sh --purge
#
# Server-driver children run in systemd user scopes whose names are NOT
# instance-qualified (`podium-oc-<uuid>`, `podium-cx-…`, `podium-gk-…`, POD-2245
# sharp edge 3), so this script never pattern-kills them: a scope is this
# instance's only if its uuid is a session here. Ending sessions through the
# product tears them down (POD-2249); anything left over is listed, not killed.

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
  else
    echo "$name not running"
  fi
  rm -f "$pidfile"
done

echo "sessions recorded in this instance:"
ls "$PODIUM_STATE_DIR"/*-servers/ 2>/dev/null | head -20 || echo "  (none)"

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$PODIUM_DRIVE_BASE"
  echo "purged $PODIUM_DRIVE_BASE"
fi
