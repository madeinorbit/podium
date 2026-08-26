#!/usr/bin/env bash
# Stop the isolated `p2843` instance. Leaves state and logs in place so a
# drive's evidence survives the teardown that produced it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
# shellcheck source=drive-lib.sh
. "$HERE/drive-lib.sh"

p2843_stop daemon
p2843_stop server

# HARNESS PROCESSES WE ORPHANED, matched on OUR agent-home path and never on the
# binary name — other sessions on this box run their own claude out of $HOME,
# and a bare `pkill -f claude` would take all of them down with it.
if pkill -f "$PODIUM_STATE_DIR/agent-home" 2>/dev/null; then
  echo "reaped harness processes spawned from $PODIUM_STATE_DIR/agent-home"
fi
# The durable terminals are ours by socket dir, which is inside the drive base.
if [ -d "$ABDUCO_SOCKET_DIR" ]; then
  pkill -f "$ABDUCO_SOCKET_DIR" 2>/dev/null && echo "reaped p2843 abduco masters" || true
fi
echo "instance '$PODIUM_INSTANCE' down; state kept at $PODIUM_STATE_DIR"
