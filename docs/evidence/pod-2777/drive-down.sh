#!/usr/bin/env bash
# Stop the isolated `p2777` instance. Leaves state and logs in place so a drive's
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
# Every arm leaves its sessions alive, the daemon ADOPTS the survivors on its
# next boot, and each opencode server is worth about 400MB. POD-2773 measured
# four arms at 1.2GB of this box's 12, on an afternoon when the host was already
# unusable — and lost a real measurement to a session that went `reconnecting`
# under the load. This drive runs far more sessions than that one did, so the
# reaping matters more, not less.
#
# MATCHED ON OUR AGENT-HOME PATH, never on the binary name. Other sessions on
# this box run their own opencode, codex and grok servers out of $HOME and out
# of other instances' state roots, and a bare `pkill -f opencode` would take all
# of them down with it.
# SELF-SAFE, and that is not paranoia: a `pkill -f <path>` run from a shell
# whose OWN command line contains that path kills the shell issuing it. That
# happened repeatedly while building this rig — exit 144, no output, and the
# drive it was supposed to protect gone with it. pgrep + an explicit self/parent
# filter is the form that cannot do that.
reaped=0
for pid in $(pgrep -f "$PODIUM_STATE_DIR/agent-home" 2>/dev/null || true); do
  [ "$pid" = "$$" ] && continue
  [ "$pid" = "$PPID" ] && continue
  kill "$pid" 2>/dev/null && reaped=$((reaped + 1))
done
[ "$reaped" -gt 0 ] && echo "reaped $reaped harness server(s) spawned from $PODIUM_STATE_DIR/agent-home"
pkill -f "podium-oc-attach" 2>/dev/null && echo "reaped stray opencode clients" || true
pkill -f "podium-gk-attach" 2>/dev/null && echo "reaped stray grok clients" || true
pkill -f "podium-cx-attach" 2>/dev/null && echo "reaped stray codex clients" || true
echo "instance '$PODIUM_INSTANCE' down; state kept at $PODIUM_STATE_DIR"
