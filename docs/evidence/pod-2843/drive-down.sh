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
if pkill -f "$PODIUM_RIG_STATE_ROOT/agent-home" 2>/dev/null; then
  echo "reaped harness processes spawned from $PODIUM_RIG_STATE_ROOT/agent-home"
fi
# THE DURABLE TERMINALS, MATCHED ON THE VENDORED BINARY'S PATH.
#
# The master's command line is `<state>/bin/abduco -n <label> …`, so cleanup
# stays scoped to the state root rather than depending on a socket-dir setting.
#
# Still scoped to OUR state root, never a bare `pkill -f claude`: other sessions
# on this box run their own claude out of $HOME and out of other instances.
if pkill -f "abduco -n podium-$PODIUM_INSTANCE-" 2>/dev/null; then
  echo "reaped p2843 durable terminals"
fi
echo "instance '$PODIUM_INSTANCE' down; state kept at $PODIUM_RIG_STATE_ROOT"
