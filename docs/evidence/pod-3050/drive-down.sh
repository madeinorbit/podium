#!/usr/bin/env bash
# Stop p3036 server/daemon and reap processes whose PODIUM_INSTANCE matches.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

for name in daemon server; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped $name ($pid)"
  fi
  rm -f "$pidfile"
done

[ -n "${PODIUM_INSTANCE:-}" ] || { echo "refusing to reap: PODIUM_INSTANCE empty" >&2; exit 2; }
reaped=0
for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  [ "$pid" = "$$" ] && continue
  [ "$pid" = "$PPID" ] && continue
  env_of="$(cat "/proc/$pid/environ" 2>/dev/null | tr '\0' '\n' || true)"
  inst="$(printf '%s' "$env_of" | sed -n 's/^PODIUM_INSTANCE=//p' | tail -1)"
  [ "$inst" = "$PODIUM_INSTANCE" ] || continue
  kill "$pid" 2>/dev/null && reaped=$((reaped + 1)) || true
done
[ "$reaped" -gt 0 ] && echo "reaped $reaped process(es) belonging to $PODIUM_INSTANCE"

CREDENTIAL="$PODIUM_RIG_STATE_ROOT/agent-home/.claude/.credentials.json"
if [ -f "$CREDENTIAL" ]; then
  rm -f "$CREDENTIAL"
  echo "deleted isolated credential copy"
fi
echo "teardown complete at $(date --iso-8601=seconds)"
