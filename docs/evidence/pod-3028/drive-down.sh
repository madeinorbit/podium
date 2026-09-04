#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/drive-env.sh"

LIVE_CREDENTIAL=/home/mgw/.claude/.credentials.json
before_mtime=""
if [ -f "$LIVE_CREDENTIAL" ]; then
  before_mtime="$(stat -c %y "$LIVE_CREDENTIAL" 2>/dev/null || true)"
fi

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

copy="$PODIUM_RIG_STATE_ROOT/agent-home/.claude/.credentials.json"
if [ -e "$copy" ]; then
  echo "unexpected isolated credential copy present: $copy" >&2
  exit 1
fi

after_mtime=""
if [ -f "$LIVE_CREDENTIAL" ]; then
  after_mtime="$(stat -c %y "$LIVE_CREDENTIAL" 2>/dev/null || true)"
fi

echo "stopped exact rig processes; no isolated credential copy; live credential left in place"
echo "liveCredentialMtimeBefore=$before_mtime"
echo "liveCredentialMtimeAfter=$after_mtime"
