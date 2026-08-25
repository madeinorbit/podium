# Isolation environment for the POD-2773 test-drive instance.
#
# Source this, never execute it — a subshell that exported these would leave the
# next command talking to the developer's LIVE instance.
#
#   . docs/evidence/pod-2773/drive-env.sh
#
# Re-cut from docs/evidence/pod-2753/drive-env.sh and POD-2761's, which are
# themselves POD-2245's recipe. DIFFERENT instance name, state root and ports
# from all of them, so every rig on this box can run side by side and no stale
# artifact of one can be read as another.
#
# WHAT THIS RIG IS FOR. POD-1761's acceptance test: watch a headless driver
# stream a reply into a chat that was opened DURING a turn already in flight,
# and compare it against the terminal driver on the same rig with the same
# script. Codex has been driven that way; grok-acp and opencode never have.

# --- identity -------------------------------------------------------------
export PODIUM_INSTANCE=p2773

# BASE PATH IS SHORT ON PURPOSE. abduco builds its master socket at
# $ABDUCO_SOCKET_DIR/abduco/<user>/<label>@<host> and hard-fails past sun_path
# (108) with "create-session: File name too long" — a failure that presents as a
# generic output timeout naming no path.
export PODIUM_DRIVE_BASE=/tmp/pod-2773
export PODIUM_STATE_DIR="$PODIUM_DRIVE_BASE/state"

# --- endpoints ------------------------------------------------------------
# PORT BASE 19837. Distinct from the OPERATOR'S 19797 — which is repinned to the
# tip and being driven by a human tonight, and which this rig must never touch —
# and from POD-2245 (19797/46797/46798), POD-2290 (19807/46807/46808),
# POD-2753 (19817/46817/46818) and POD-2761 (19827/46827/46828).
export PODIUM_PORT=19837
export PODIUM_HOOK_PORT=46837
export PODIUM_AGENT_RELAY_PORT=46838
export PODIUM_HOST=127.0.0.1

# --- durable-terminal containment ----------------------------------------
# abduco 0.6 silently FALLS BACK to the real socket dir when $ABDUCO_SOCKET_DIR
# does not exist, so these are created below before anything can run abduco.
export ABDUCO_SOCKET_DIR="$PODIUM_DRIVE_BASE/abduco"
export TMUX_TMPDIR="$PODIUM_DRIVE_BASE/tmux"

# --- scrub the inherited session ------------------------------------------
# This shell runs INSIDE a Podium session on the developer's default instance,
# which exports these; inheriting any of them routes CLI calls back into the live
# server.
unset PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY
unset PODIUM_AGENT_RELAY PODIUM_HOME PODIUM_WEB_DIR
unset ABDUCO_SESSION ABDUCO_SOCKET
export PODIUM_NO_RELAY=1

# THE HARNESS'S OWN CONTROL VARIABLES (POD-2086 F5). A daemon started from inside
# a Claude Code session passes these to every child it spawns, the child stops
# saving its transcript, and the session reports `idle` forever.
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# --- THE TWO ARMS ---------------------------------------------------------
# The whole drive is a comparison, so the thing that differs between the arms is
# a knob HERE rather than an edit anywhere, and drive-verify.sh reads it back out
# of the RUNNING daemon's /proc/<pid>/environ. That last part is the point: the
# arm a script intended and the arm a long-lived process is actually running are
# different facts, and this epic has confused them before.
#
#   P2773_DRIVER=generic-pty   THE CONTROL, and it took a wrong turn to find.
#                     The obvious knob is PODIUM_RUNTIME_CONTRACT=0, and it does
#                     NOT work: the flag is only the MACHINE-WIDE half of
#                     `runtimeContractEnabledFor`, a session carries its own, and
#                     an opencode session bound `opencode-server` with the
#                     machine flag off. That arm was run and reported 25 preview
#                     frames — a control that measured the treatment. Recorded
#                     here rather than quietly replaced, because the failure mode
#                     is invisible without reading the bound driverId back, which
#                     is exactly why drive.ts now prints it.
#
#                     What actually reverts the driver is the operator
#                     preference. `selectRuntimeDriver` lets an explicit choice
#                     win over the policy, and 'generic-pty' is the terminal id
#                     every harness declares. That driver declares watchLevels
#                     ['coarse'] and nothing else, so it is the pre-contract
#                     world: same rig, same script, same preview plane, same
#                     prompt, and the only difference is which driver bound.
#
#   P2773_STREAMING=0 turns the preview PLANE off with the driver unchanged — a
#                     second, narrower control that separates "the plane
#                     delivered nothing" from "the driver produced nothing".
#
#   P2773_CONTRACT    kept as a knob so the finding above stays reproducible.
export PODIUM_RUNTIME_CONTRACT="${P2773_CONTRACT:-1}"
export PODIUM_CHAT_STREAMING="${P2773_STREAMING:-1}"
if [ -n "${P2773_DRIVER:-}" ]; then export PODIUM_RUNTIME_DRIVER="$P2773_DRIVER"; else unset PODIUM_RUNTIME_DRIVER; fi

# --- the daemon has to say when it takes the watch ------------------------
# `fine watch acquired` is logged at DEBUG (apps/daemon/src/runtime/watch.ts),
# and it is the one line that proves the viewer's subscribe crossed the process
# boundary and moved the driver's refcount. Without it, a zero cannot be told
# apart from "nobody ever asked the driver for fragments" — which is one of the
# three explanations this drive is required to choose between.
export PODIUM_LOG_LEVEL="${P2773_LOG_LEVEL:-debug}"

# --- code under test ------------------------------------------------------
export PODIUM_DRIVE_REPO=/home/mgw/src/podium/.worktrees/issue-2773-drive-streaming-on-grok-and-opencode

# THE HARNESS BINARIES ARE NOT ON A LOGIN PATH. opencode installs to
# ~/.opencode/bin and grok to ~/.local/bin; a daemon that cannot resolve either
# falls back to a generic PTY, which produces no fragments and reads exactly
# like "the feature does not work". drive-verify.sh refuses the drive if the
# session did not bind the driver the arm asked for, for this reason.
export PATH="$HOME/.bun/bin:$HOME/.opencode/bin:$HOME/.local/bin:$PATH"

mkdir -p "$PODIUM_STATE_DIR" "$ABDUCO_SOCKET_DIR" "$TMUX_TMPDIR"
chmod 700 "$PODIUM_DRIVE_BASE"
