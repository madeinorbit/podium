# Isolation environment for the POD-2853 named-instance terminal-spawn drive.
#
# Source this, never execute it — a subshell that exported these would leave the
# next command talking to the developer's LIVE instance.
#
#   . docs/evidence/pod-2853/drive-env.sh
#
# Re-cut from docs/evidence/pod-2843/drive-env.sh, which is POD-2245's recipe.
#
# WHAT THIS RIG IS FOR, AND WHAT IT DELIBERATELY DOES NOT SET.
#
# Every earlier rig on this box exports a short ABDUCO_SOCKET_DIR by hand, with
# a comment explaining that abduco hard-fails past sun_path (108). That export
# IS THE BUG UNDER TEST here, so this rig does not carry it. A named instance
# has to compose a socket path that fits on its own, from nothing but its
# instance id and its state root, or it cannot start a terminal at all.
#
# THE STATE ROOT IS THE DOCUMENTED DEFAULT SHAPE, not a short scratch path.
# docs/multi-instance.md says a named instance's state lives at
# ${XDG_STATE_HOME:-$HOME/.local/state}/podium/<id>. That is what anyone running
# a second Podium actually gets, and it is the harshest realistic case: it is
# LONGER than the operator's own /home/mgw/.pod-op-state. A rig that shortened
# it would be measuring a path no user has.

# --- identity -------------------------------------------------------------
export PODIUM_INSTANCE=p2853

# THE DOCUMENTED DEFAULT for a named instance, spelled out rather than derived,
# so the drive's evidence names the exact root it ran against.
export PODIUM_STATE_DIR="$HOME/.local/state/podium/p2853"
# Scratch repo, logs, pidfiles and cookie jar — NOT the socket root.
export PODIUM_DRIVE_BASE=/tmp/pod-2853

# --- endpoints ------------------------------------------------------------
# PORT BASE 19887. Distinct from the operator's 19797 and from POD-2245
# (19797), POD-2290 (19807), POD-2753 (19817), POD-2761 (19827), POD-2773
# (19837), POD-2801 (19847), POD-2836 (19867) and POD-2843 (19877).
export PODIUM_PORT=19887
export PODIUM_HOOK_PORT=46887
export PODIUM_AGENT_RELAY_PORT=46888
export PODIUM_HOST=127.0.0.1

# --- durable-terminal containment ----------------------------------------
# DELIBERATELY ABSENT: ABDUCO_SOCKET_DIR and TMUX_TMPDIR. Setting either is the
# workaround this issue exists to remove, and applyInstanceRuntimeEnv only pins
# them when they are unset — an export here would switch the subject off.
#
# P2853_ABDUCO_SOCKET_DIR is the ONE knob that puts a hand-set short root back,
# because that manoeuvre is itself an arm: it is what the reporter did to get
# past the length error and reach the second defect underneath it.
unset ABDUCO_SOCKET_DIR TMUX_TMPDIR
if [ -n "${P2853_ABDUCO_SOCKET_DIR:-}" ]; then
  export ABDUCO_SOCKET_DIR="$P2853_ABDUCO_SOCKET_DIR"
  # P2853_ABDUCO_SOCKET_DIR_NOMKDIR is the DEFECT 2 arm, and it is a real
  # operator configuration rather than a contrivance: abduco's `mkdir` of
  # `<root>/abduco/` is NOT recursive, so a root whose parent does not exist
  # yet makes abduco fall silently through to the next root in its chain
  # (HOME, then TMPDIR, then /tmp) and create the master THERE. The create
  # succeeds and says nothing. A probe that only looks under ABDUCO_SOCKET_DIR
  # then reports a running session as absent.
  if [ -z "${P2853_ABDUCO_SOCKET_DIR_NOMKDIR:-}" ]; then mkdir -p "$ABDUCO_SOCKET_DIR"; fi
fi

# THE AGENT HOME, which is the `HOME` rung of abduco's socket-directory chain
# (the abduco child runs under ctx.homeDir, POD-2247). Left at the instance
# default — <state>/agent-home — unless an arm needs that rung to be short
# enough for abduco to actually land there. It is 114 bytes at the default,
# which is over the limit, so abduco refuses there rather than falling through
# to it, and the DEFECT 2 arm needs it to fit.
if [ -n "${P2853_AGENT_HOME:-}" ]; then
  export PODIUM_AGENT_HOME="$P2853_AGENT_HOME"
  mkdir -p "$PODIUM_AGENT_HOME"
else
  unset PODIUM_AGENT_HOME
fi

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

# THE DRIVER IS LEFT TO POLICY, and that is a correction to this rig's first
# run. The subject is the TERMINAL spawn path, so the instinct was to force
# PODIUM_RUNTIME_DRIVER=generic-pty — but claude-code has no server driver to
# be forced away from, and the pin made the server refuse the spawn outright
# with "runtime driver 'generic-pty' is not wired for harness 'claude-code'".
# That is a rig failure that never reaches abduco, and it would have been read
# as "the named instance cannot spawn". Left unset so claude takes its own
# terminal path; kept as a knob so a codex arm is one variable rather than an
# edit.
if [ -n "${P2853_DRIVER:-}" ]; then export PODIUM_RUNTIME_DRIVER="$P2853_DRIVER"; else unset PODIUM_RUNTIME_DRIVER; fi

# DEBUG: the lines this drive reads are the spawn's own — the create argv, the
# socket wait and the failure text. At info the failure is a bare row field.
export PODIUM_LOG_LEVEL="${P2853_LOG_LEVEL:-debug}"

# --- code under test ------------------------------------------------------
# The ARM. Defaults to this worktree (the fix); the control arm points it at a
# detached checkout of the epic tip carrying nothing but these rig files.
export PODIUM_DRIVE_REPO="${P2853_REPO:-/home/mgw/src/podium/.worktrees/issue-2853-bug-a-named-instance-cannot-start-any-te}"

# THE HARNESS BINARY IS NOT ON A LOGIN PATH.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

mkdir -p "$PODIUM_STATE_DIR" "$PODIUM_DRIVE_BASE"
chmod 700 "$PODIUM_DRIVE_BASE"
