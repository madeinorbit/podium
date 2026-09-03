# Isolation environment for the POD-2777 acceptance-drive instance.
#
# Source this, never execute it — a subshell that exported these would leave the
# next command talking to the developer's LIVE instance.
#
#   . docs/evidence/pod-2792/drive-env.sh
#
# Re-cut from docs/evidence/pod-2773/drive-env.sh (itself from POD-2761's and
# POD-2245's recipe). DIFFERENT instance name, state root and ports from all of
# them, so every rig on this box can run side by side and no stale artifact of
# one can be read as another.
#
# WHAT THIS RIG IS FOR. POD-1761's acceptance test, whole: nine behaviours from
# the driver-capability catalogue, driven on four harnesses, EACH ON BOTH
# DRIVERS where the harness can run both ways. The question is not "does
# headless work" but "is headless BETTER, and is the terminal path NO WORSE" —
# and only a side-by-side answers that.

# --- identity -------------------------------------------------------------
export PODIUM_INSTANCE=p2792

# The product chooses durable-terminal paths from the named state root.
# This rig deliberately leaves those choices untouched so its result matches
# an ordinary installation.
export PODIUM_DRIVE_BASE=/tmp/pod-2792

. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/rig-path-guard.sh"

# --- endpoints ------------------------------------------------------------
# PORT BASE 19847. Distinct from the OPERATOR'S 19797 — which this rig must
# never touch, and which drive-verify.sh refuses outright — and from POD-2245
# (19797), POD-2290 (19807), POD-2753 (19817), POD-2761 (19827) and POD-2773
# (19837).
export PODIUM_PORT=19857
export PODIUM_HOOK_PORT=46857
export PODIUM_AGENT_RELAY_PORT=46858
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
# stops saving its transcript, and the session reports `idle` forever.
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# --- THE TWO ARMS ---------------------------------------------------------
# The whole drive is a comparison, so the thing that differs between the arms is
# a knob HERE rather than an edit anywhere, and drive-verify.sh reads it back
# out of the RUNNING daemon's /proc/<pid>/environ. That last part is the point:
# the arm a script intended and the arm a long-lived process is actually running
# are different facts, and this epic has confused them before.
#
#   P2777_DRIVER=generic-pty   THE CONTROL ARM — the terminal driver, the "old
#                     path" this epic is judged against. POD-2773 recorded why
#                     the obvious knob is the wrong one: PODIUM_RUNTIME_CONTRACT=0
#                     is only the MACHINE-WIDE half of `runtimeContractEnabledFor`
#                     and a session carries its own, so that arm ran with the
#                     headless driver still bound and reported 25 preview frames —
#                     a control that had measured the treatment. What actually
#                     reverts the driver is the operator preference, which
#                     `selectRuntimeDriver` lets win over the policy.
#
#   P2777_STREAMING=0 turns the preview PLANE off with the driver unchanged — a
#                     narrower control separating "the plane delivered nothing"
#                     from "the driver produced nothing".
export PODIUM_RUNTIME_CONTRACT="${P2777_CONTRACT:-1}"
export PODIUM_CHAT_STREAMING="${P2777_STREAMING:-1}"
if [ -n "${P2777_DRIVER:-}" ]; then export PODIUM_RUNTIME_DRIVER="$P2777_DRIVER"; else unset PODIUM_RUNTIME_DRIVER; fi

# --- the daemon has to say when it takes the watch ------------------------
# `fine watch acquired` is logged at DEBUG (apps/daemon/src/runtime/watch.ts),
# and it is the one line that proves a viewer's subscribe crossed the process
# boundary and moved the driver's refcount. Without it a zero cannot be told
# apart from "nobody ever asked the driver for fragments".
export PODIUM_LOG_LEVEL="${P2777_LOG_LEVEL:-debug}"

# --- code under test ------------------------------------------------------
# This worktree, which is reset onto the EPIC branch (issue/1761-agent-runtime)
# rather than main: the drivers under test live there and nowhere else.
export PODIUM_DRIVE_REPO="${P2777_REPO:-/home/mgw/src/podium/.worktrees/issue-2792-bug-interrupt-reports-success-but-the-tu}"

# THE HARNESS BINARIES ARE NOT ON A LOGIN PATH. opencode installs to
# ~/.opencode/bin, grok and claude to ~/.local/bin; a daemon that cannot resolve
# one falls back to a generic PTY, which reads exactly like "the headless driver
# does not work". drive.ts refuses any probe whose session did not bind the
# driver its arm asked for, for this reason.
#
# ~/.local/bin COMES FIRST, AND THE ORDER IS LOAD-BEARING. This box has TWO
# codex binaries: ~/.bun/bin/codex is the npm wrapper pinned at 0.146.0, and
# ~/.local/bin/codex is the standalone at 0.149.1. The codex app-server driver
# is only exercised against 0.147.x-0.149.x, so with .bun/bin first the daemon
# resolved 0.146.0, the version gate refused loudly and CORRECTLY, and the
# session fell back to generic-pty — which refused all nine codex probes.
#
# That was a fact about this rig's PATH, not about the product, and it is
# exactly the shape that gets written up as "codex cannot run headless". The
# gate did its job on the version it was handed; the rig handed it the wrong
# binary. `codex` is the ONLY name that overlaps between the two directories, so
# this reorder changes nothing else — bun still resolves from ~/.bun/bin.
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"

mkdir -p "$PODIUM_RIG_STATE_ROOT"
chmod 700 "$PODIUM_DRIVE_BASE"
