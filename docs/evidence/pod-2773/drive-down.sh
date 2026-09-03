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
# HARNESS SERVERS WE ORPHANED, and this is not tidiness — it is the host.
#
# Every drive leaves its session alive, the daemon ADOPTS the survivors on its
# next boot, and each arm therefore adds an `opencode serve` worth about 400MB.
# Four arms into this drive that was 1.2GB of this box's 12, on an afternoon
# when three sessions running suites at once had already made it unusable. The
# rig's own plane-off control then failed on a session that went `reconnecting`
# under load — a real measurement lost to a host this script should have kept
# clean.
#
# MATCHED ON OUR AGENT-HOME PATH, never on the binary name. Other sessions on
# this box run their own opencode and grok servers out of $HOME and out of other
# instances' state roots, and a bare `pkill -f opencode` would take all of them
# down with it.
if pkill -f "$PODIUM_RIG_STATE_ROOT/agent-home" 2>/dev/null; then
  echo "reaped harness servers spawned from $PODIUM_RIG_STATE_ROOT/agent-home"
fi
pkill -f "podium-oc-attach" 2>/dev/null && echo "reaped stray opencode clients" || true
pkill -f "podium-gk-attach" 2>/dev/null && echo "reaped stray grok clients" || true
echo "instance '$PODIUM_INSTANCE' down; state kept at $PODIUM_RIG_STATE_ROOT"
