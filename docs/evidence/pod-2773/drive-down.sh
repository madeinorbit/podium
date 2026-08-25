#!/usr/bin/env bash
# Stop the isolated `p2773` instance. Leaves state and logs in place so a drive's
# evidence survives the teardown that produced it.
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
# Harness children we orphaned by killing their daemon.
pkill -f "podium-oc-attach" 2>/dev/null && echo "reaped stray opencode clients" || true
pkill -f "podium-gk-attach" 2>/dev/null && echo "reaped stray grok clients" || true
echo "instance '$PODIUM_INSTANCE' down; state kept at $PODIUM_STATE_DIR"
