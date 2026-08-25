# Isolation environment for the POD-2761 test-drive instance.
#
# Source this, never execute it — a subshell that exported these would leave the
# next command talking to the developer's LIVE instance.
#
#   . docs/evidence/pod-2761/drive-env.sh
#
# Re-cut from docs/evidence/pod-2753/drive-env.sh. DIFFERENT instance name, state
# root and ports from that one, from POD-2290's (19807) and from the OPERATOR's
# instance at 19797 — which is in use by a person and must not be touched.

# --- identity -------------------------------------------------------------
export PODIUM_INSTANCE=p2761

# BASE PATH IS SHORT ON PURPOSE. abduco builds its master socket at
# $ABDUCO_SOCKET_DIR/abduco/<user>/<label>@<host> and hard-fails past sun_path
# (108) with "create-session: File name too long" — a failure that presents as a
# generic output timeout naming no path. This drive's whole subject is those
# masters, so the limit is not a footnote here.
export PODIUM_DRIVE_BASE=/tmp/pod-2761
export PODIUM_STATE_DIR="$PODIUM_DRIVE_BASE/state"

# --- endpoints ------------------------------------------------------------
export PODIUM_PORT=19827
export PODIUM_HOOK_PORT=46827
export PODIUM_AGENT_RELAY_PORT=46828
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

# --- ABDUCO STAYS REAL, AND THAT IS THE OPPOSITE OF POD-2753 --------------
# 2753's env points $PODIUM_ABDUCO at a path that does not run, to force headless
# turns off the durable backend and onto the SDK path it was testing. Doing that
# here would delete the subject: a client terminal IS an abduco master
# (`podium-cx-attach-<session>`), and what this drive measures is whether a new
# one is started per view switch and what it paints when it is. So $PODIUM_ABDUCO
# is deliberately left unset — the daemon resolves the real ~/.podium/bin/abduco.
# Said out loud because copying 2753's env wholesale would silently pass.

# --- code under test ------------------------------------------------------
export PODIUM_DRIVE_REPO=/home/mgw/src/podium/.worktrees/issue-2761-bug-switching-to-cli-restarts-the-codex
export PATH="$HOME/.bun/bin:$PATH"

mkdir -p "$PODIUM_STATE_DIR" "$ABDUCO_SOCKET_DIR" "$TMUX_TMPDIR"
chmod 700 "$PODIUM_DRIVE_BASE"
