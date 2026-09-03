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
if pkill -f "$P2853_STATE_ROOT/agent-home" 2>/dev/null; then
  echo "reaped harness processes spawned from $P2853_STATE_ROOT/agent-home"
fi
# THE DURABLE TERMINALS, MATCHED ON THE INSTANCE-PREFIXED LABEL. The master
# command line names the session label, not the socket directory, so matching
# the label remains valid whichever product-selected root it uses.
if pkill -f "abduco -n podium-$PODIUM_INSTANCE-" 2>/dev/null; then
  echo "reaped p2853 durable terminals"
fi
echo "instance '$PODIUM_INSTANCE' down; state kept at $P2853_STATE_ROOT"
