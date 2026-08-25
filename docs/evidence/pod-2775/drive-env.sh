# Isolation environment for the POD-2775 test-drive instance.
#
# Source this, never execute it — a subshell that exported these would leave the
# next command talking to the developer's LIVE instance.
#
#   . docs/evidence/pod-2775/drive-env.sh
#
# Re-cut from docs/evidence/pod-2761/drive-env.sh. DIFFERENT instance name, state
# root and ports from that one (19827), from POD-2773's (19837), from POD-2290's
# (19807) and from the OPERATOR's instance at 19797 — which is in use by a person
# and must not be touched.

# --- identity -------------------------------------------------------------
export PODIUM_INSTANCE=p2775

# BASE PATH IS SHORT ON PURPOSE. abduco builds its master socket at
# $ABDUCO_SOCKET_DIR/abduco/<user>/<label>@<host> and hard-fails past sun_path
# (108) with "create-session: File name too long". This drive also runs a codex
# app-server, whose JSON-RPC listener is ITSELF a unix socket under the state
# root, so the limit binds twice here.
export PODIUM_DRIVE_BASE=/tmp/pod-2775
export PODIUM_STATE_DIR="$PODIUM_DRIVE_BASE/state"

# --- endpoints ------------------------------------------------------------
# MOVED OFF 19847/46847/46848 — POD-2777's acceptance rig picked the same three,
# and on a shared host the second one up just fails to bind ("port 19847 is
# already in use") while its /auth/login answers 401 against the OTHER
# instance's server. Two rigs on one port is a wrong measurement, not a busy
# port: a drive that logged in there would be driving somebody else's daemon.
# Different from the operator's 19797, from 2761's 19827, 2773's 19837 and
# 2777's 19847.
export PODIUM_PORT=19867
export PODIUM_HOOK_PORT=46867
export PODIUM_AGENT_RELAY_PORT=46868
export PODIUM_HOST=127.0.0.1

# --- durable-terminal containment ----------------------------------------
# abduco 0.6 silently FALLS BACK to the real socket dir when $ABDUCO_SOCKET_DIR
# does not exist, so these are created below before anything can run abduco.
export ABDUCO_SOCKET_DIR="$PODIUM_DRIVE_BASE/abduco"
export TMUX_TMPDIR="$PODIUM_DRIVE_BASE/tmux"

# --- scrub the inherited session ------------------------------------------
unset PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY
unset PODIUM_AGENT_RELAY PODIUM_HOME PODIUM_WEB_DIR
unset ABDUCO_SESSION ABDUCO_SOCKET
export PODIUM_NO_RELAY=1
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# --- ABDUCO STAYS REAL ----------------------------------------------------
# Inherited from 2761's env for the same reason it kept it: $PODIUM_ABDUCO is
# left unset so the daemon resolves the real ~/.podium/bin/abduco. A codex
# app-server session has no abduco master of its own, but the SCOPE reclaim this
# drive exercises runs through the same @podium/pty helpers, and a rig that
# stubbed the durable backend would be measuring a different teardown.

# --- code under test ------------------------------------------------------
export PODIUM_DRIVE_REPO=/home/mgw/src/podium/.worktrees/issue-2775-bug-hibernating-a-codex-session-wedges-i

# THE RIG'S OWN PATH CHOOSES THE HARNESS VERSION, AND ~/.bun/bin CHOOSES WRONG.
# ~/.bun/bin holds an old global `codex` shim that the app-server driver's
# version gate REFUSES, and the refusal is quiet: the driver degrades to
# `generic-pty` behind one warn line, the session still answers prompts, and the
# server-driver teardown path this issue is about is never entered at all. So
# ~/.local/bin goes first and bun's bin stays available behind it.
#
# AND ~/.opencode/bin, WHICH IS ON NOBODY'S PATH BY DEFAULT. The opencode arm
# needs `opencode serve` to be findable by the daemon's child spawn, and this
# host installs it only there. Left off, the driver never starts a server and
# the arm degrades exactly like a refused codex — quietly.
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"

mkdir -p "$PODIUM_STATE_DIR" "$ABDUCO_SOCKET_DIR" "$TMUX_TMPDIR"
chmod 700 "$PODIUM_DRIVE_BASE"
