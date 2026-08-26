# Isolation environment for the POD-2753 test-drive instance.
#
# Source this, never execute it — a subshell that exported these would leave the
# next command talking to the developer's LIVE instance.
#
#   . docs/evidence/pod-2753/drive-env.sh
#
# Re-cut from docs/evidence/pod-2290/drive-env.sh, which is itself POD-2245's
# recipe. DIFFERENT instance name, state root and ports from both, so all three
# can run side by side and no stale artifact of one can be read as the other.
#
# ON THE BRIEF'S 'build-a-rig.sh from POD-2745': there is no such file. It is not
# in this worktree, not on issue/1761-agent-runtime, not on POD-2745's branch,
# and not anywhere in history — checked before writing this. The pod-2290 scripts
# are the real thing it describes, so this is a re-cut of those plus the two
# properties the brief actually asks for: verify what is RUNNING against a named
# commit (drive-verify.sh), and refuse to report a measurement until a control
# proves the path is alive (drive-kill.sh).

# --- identity -------------------------------------------------------------
export PODIUM_INSTANCE=p2753

# The base contains only this rig's state, logs and scratch repository.
export PODIUM_DRIVE_BASE=/tmp/pod-2753
export PODIUM_STATE_DIR="$PODIUM_DRIVE_BASE/state"

# --- endpoints ------------------------------------------------------------
# Distinct from the live instance, from POD-2245's operator (19797/46797/46798)
# and from POD-2290's (19807/46807/46808).
export PODIUM_PORT=19817
export PODIUM_HOOK_PORT=46817
export PODIUM_AGENT_RELAY_PORT=46818
export PODIUM_HOST=127.0.0.1

# --- durable-terminal selection ------------------------------------------
# Leave both variables unset. The named-instance runtime must choose the
# durable backend paths that an installed instance would use.

# --- scrub the inherited session ------------------------------------------
# This shell runs INSIDE a Podium session on the developer's default instance,
# which exports these; inheriting any of them routes CLI calls back into the live
# server.
unset PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY
unset PODIUM_AGENT_RELAY PODIUM_HOME PODIUM_WEB_DIR
unset ABDUCO_SESSION ABDUCO_SOCKET ABDUCO_SOCKET_DIR TMUX_TMPDIR
export PODIUM_NO_RELAY=1

# THE HARNESS'S OWN CONTROL VARIABLES (POD-2086 F5). A daemon started from inside
# a Claude Code session passes these to every claude it spawns, the child stops
# saving its transcript, and since the transcript IS Podium's state channel for
# claude the session reports `idle` forever. Doubly load-bearing here: this
# issue's whole subject is a claude child process.
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# --- FORCE THE PATH UNDER TEST --------------------------------------------
# The Claude SDK driver is the NON-DURABLE path. control/headless.ts routes a
# headless turn to the durable abduco driver when ctx.backend === 'abduco', and
# that driver spawns the claude CLI directly — it never touched the SDK. So on a
# box with abduco installed (this one: ~/.podium/bin/abduco), a default daemon
# would take the durable path and this drive would measure code the change does
# not touch, then report a pass.
#
# $PODIUM_ABDUCO is the documented explicit override, and it FAILS resolution
# rather than falling back when the path does not run — which is exactly the
# property needed here. abduco unavailable + tmux present resolves the backend to
# 'tmux', which is not 'abduco', so headless turns go through runHeadlessTurn and
# into the child host. That is a real production configuration (any box without
# abduco, and every Windows box), not a contrivance for the test.
export PODIUM_ABDUCO=/nonexistent/abduco-forced-off-for-pod-2753

# --- code under test ------------------------------------------------------
export PODIUM_DRIVE_REPO=/home/mgw/src/podium/.worktrees/issue-2753-move-the-claude-sdk-out-of-the-daemon
export PATH="$HOME/.bun/bin:$PATH"

mkdir -p "$PODIUM_STATE_DIR"
chmod 700 "$PODIUM_DRIVE_BASE"
