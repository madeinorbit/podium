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

# The product chooses durable-terminal paths from the named state root.
# This rig deliberately leaves those choices untouched so its result matches
# an ordinary installation.
export PODIUM_DRIVE_BASE=/tmp/pod-2761

. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/rig-path-guard.sh"

# --- endpoints ------------------------------------------------------------
export PODIUM_PORT=19827
export PODIUM_HOOK_PORT=46827
export PODIUM_AGENT_RELAY_PORT=46828
export PODIUM_HOST=127.0.0.1

# Do not shorten or relocate product-selected terminal paths in this rig.
unset ABDUCO_SOCKET_DIR TMUX_TMPDIR

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

# THE RIG'S OWN PATH CHOSE THE HARNESS VERSION, AND CHOSE WRONG.
# 2753's env prepends ~/.bun/bin, which it needs for `bun`. But that directory
# also holds a `codex` shim — 0.146.0, an old global install — while the codex a
# person actually runs is ~/.local/bin/codex (0.149.1). Prepending bun's bin
# therefore handed the daemon a codex the app-server driver's version gate
# REFUSES, and the refusal does not look like a version problem from the outside:
# the driver degrades to `generic-pty` behind one warn line, the session still
# answers prompts, and no client terminal is ever started. The drive then has
# nothing to measure while looking like it worked.
# So ~/.local/bin goes first and bun's bin stays available behind it.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

mkdir -p "$PODIUM_RIG_STATE_ROOT"
chmod 700 "$PODIUM_DRIVE_BASE"
