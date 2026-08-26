#!/usr/bin/env bash
# Stop the isolated `p2853` instance. Leaves state and logs in place so a
# drive's evidence survives the teardown that produced it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
# shellcheck source=drive-lib.sh
. "$HERE/drive-lib.sh"

p2853_stop daemon
p2853_stop server

# HARNESS PROCESSES WE ORPHANED, matched on OUR agent-home path and never on the
# binary name — other sessions on this box run their own claude out of $HOME.
if pkill -f "$PODIUM_STATE_DIR/agent-home" 2>/dev/null; then
  echo "reaped harness processes spawned from $PODIUM_STATE_DIR/agent-home"
fi
# THE DURABLE TERMINALS, MATCHED ON THE VENDORED BINARY'S PATH. The master's
# command line is `<state>/bin/abduco -n <label> …` and names the SOCKET dir
# nowhere, so a pattern on ABDUCO_SOCKET_DIR hits nothing and reaps nothing.
if pkill -f "$PODIUM_STATE_DIR/bin/abduco -n" 2>/dev/null; then
  echo "reaped p2853 durable terminals"
fi
# Same for a master that resolved abduco from the shared cache rather than this
# state root: match the LABEL, which is instance-prefixed and cannot collide.
if pkill -f "abduco -n podium-$PODIUM_INSTANCE-" 2>/dev/null; then
  echo "reaped p2853 durable terminals (shared-binary masters)"
fi
echo "instance '$PODIUM_INSTANCE' down; state kept at $PODIUM_STATE_DIR"
