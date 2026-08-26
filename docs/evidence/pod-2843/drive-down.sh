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
# THE DURABLE TERMINALS, MATCHED ON THE VENDORED BINARY'S PATH.
#
# Matching on $ABDUCO_SOCKET_DIR was wrong and left nine processes running after
# a teardown that reported success: the master's command line is
# `<state>/bin/abduco -n <label> …` and names the SOCKET dir nowhere, so the
# pattern hit nothing. Every arm leaves a claude behind, so a teardown that
# silently reaps none of them costs this box about 400MB per arm — the same
# accounting POD-2773's script had to add for opencode.
#
# Still scoped to OUR state root, never a bare `pkill -f claude`: other sessions
# on this box run their own claude out of $HOME and out of other instances.
if pkill -f "$PODIUM_STATE_DIR/bin/abduco -n" 2>/dev/null; then
  echo "reaped p2843 durable terminals"
fi
echo "instance '$PODIUM_INSTANCE' down; state kept at $PODIUM_STATE_DIR"
