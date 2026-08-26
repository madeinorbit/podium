# Isolation environment for the POD-2843 reattach-send test-drive instance.
#
# Source this, never execute it — a subshell that exported these would leave the
# next command talking to the developer's LIVE instance.
#
#   . docs/evidence/pod-2843/drive-env.sh
#
# Re-cut from docs/evidence/pod-2773/drive-env.sh, which is POD-2245's recipe.
# DIFFERENT instance name, state root and ports from every other rig on this
# box, so no stale artifact of one can be read as another.
#
# WHAT THIS RIG IS FOR. POD-2836 reported, while measuring something else, that
# typing into a REATTACHED claude session after a server OR daemon restart never
# reaches the CLI — five attempts, no user turn. This rig restarts one half at a
# time under a session that has already taken a send, and reads the CLI's OWN
# transcript file on disk rather than the server's view of it, because "the turn
# never happened" and "the server cannot see the turn" are different bugs.

# --- identity -------------------------------------------------------------
export PODIUM_INSTANCE=p2843

# The product chooses durable-terminal paths from the named state root.
# This rig deliberately leaves those choices untouched so its result matches
# an ordinary installation.
export PODIUM_DRIVE_BASE=/tmp/pod-2843

. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/rig-path-guard.sh"

# --- endpoints ------------------------------------------------------------
# PORT BASE 19877. Distinct from the operator's 19797 and from POD-2245
# (19797), POD-2290 (19807), POD-2753 (19817), POD-2761 (19827), POD-2773
# (19837), POD-2801 (19847) and POD-2836 (19867).
export PODIUM_PORT=19877
export PODIUM_HOOK_PORT=46877
export PODIUM_AGENT_RELAY_PORT=46878
export PODIUM_HOST=127.0.0.1

# Do not shorten or relocate product-selected terminal paths in this rig.
unset ABDUCO_SOCKET_DIR TMUX_TMPDIR

# --- scrub the inherited session ------------------------------------------
# This shell runs INSIDE a Podium session on the developer's default instance,
# which exports these; inheriting any of them routes CLI calls back into the
# live server.
unset PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY
unset PODIUM_AGENT_RELAY PODIUM_HOME PODIUM_WEB_DIR
unset ABDUCO_SESSION ABDUCO_SOCKET
export PODIUM_NO_RELAY=1

# THE HARNESS'S OWN CONTROL VARIABLES (POD-2086 F5). A daemon started from
# inside a Claude Code session passes these to every child it spawns, the child
# stops saving its transcript, and the session reports `idle` forever — which
# would be a perfect false positive for the bug under test here.
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# --- the arm --------------------------------------------------------------
# The subject is the TERMINAL path (a real claude-code CLI in a real PTY), so
# the driver is left to policy; claude has no server driver today. Kept as a
# knob so a control arm is one variable rather than an edit.
if [ -n "${P2843_DRIVER:-}" ]; then export PODIUM_RUNTIME_DRIVER="$P2843_DRIVER"; else unset PODIUM_RUNTIME_DRIVER; fi

# DEBUG, because the lines this drive turns on are the drain's own: the bind
# announcement, the type attempt and the confirm poll. At info they are absent
# and a silent drain cannot be told from a drain that never ran.
export PODIUM_LOG_LEVEL="${P2843_LOG_LEVEL:-debug}"

# --- code under test ------------------------------------------------------
export PODIUM_DRIVE_REPO=/home/mgw/src/podium/.worktrees/issue-2843-bug-a-reattached-session-stops-accepting

# THE HARNESS BINARY IS NOT ON A LOGIN PATH.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

mkdir -p "$PODIUM_RIG_STATE_ROOT"
chmod 700 "$PODIUM_DRIVE_BASE"
