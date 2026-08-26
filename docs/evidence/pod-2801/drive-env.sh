# Isolation environment for this issue's phase rig (POD-2801).
#
# Source this, never execute it.
#
#   . docs/evidence/pod-2801/drive-env.sh
#
# Re-cut from docs/evidence/pod-2777/drive-env.sh, which is where the defect was
# first measured. DIFFERENT instance name, state root and ports from that rig
# and from every other on this box, because POD-2777's `p2777` instance is
# usually UP and this rig must never read or disturb it.

export PODIUM_INSTANCE=p2801
export PODIUM_DRIVE_BASE=/tmp/pod-2801
export PODIUM_STATE_DIR="$PODIUM_DRIVE_BASE/state"

# PORT BASE 19877. Distinct from the operator's 19797 and from POD-2245/2290/
# 2753/2761/2773/2777 (19797/19807/19817/19827/19837/19847).
export PODIUM_PORT=19877
export PODIUM_HOOK_PORT=46877
export PODIUM_AGENT_RELAY_PORT=46878
export PODIUM_HOST=127.0.0.1

# The product chooses durable-terminal paths from the named state root.
# This rig deliberately leaves those choices untouched so its result matches
# an ordinary installation.
unset ABDUCO_SOCKET_DIR TMUX_TMPDIR

# This shell runs INSIDE a Podium session on the developer's default instance,
# which exports these; inheriting any of them routes CLI calls back to the live
# server.
unset PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY
unset PODIUM_AGENT_RELAY PODIUM_HOME PODIUM_WEB_DIR
unset ABDUCO_SESSION ABDUCO_SOCKET
export PODIUM_NO_RELAY=1

# A daemon started from inside a Claude Code session passes these to every child
# it spawns, the child stops saving its transcript, and the session reports
# `idle` forever — which is the very symptom under test here, so leaving them in
# would fake the bug.
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# THE ARM. `generic-pty` by default: this rig exists to measure the TERMINAL
# driver, so the terminal arm is the default rather than an opt-in. The knob is
# the operator preference, not PODIUM_RUNTIME_CONTRACT — POD-2773 recorded why
# (CONTRACT=0 is only the machine-wide half and a session carries its own, so
# that arm still binds the headless driver).
export PODIUM_RUNTIME_CONTRACT="${P2801_CONTRACT:-1}"
export PODIUM_CHAT_STREAMING="${P2801_STREAMING:-1}"
#
# `claude-pty` FOR CLAUDE AND `generic-pty` FOR EVERYONE ELSE. The terminal
# family has two drivers, and claude is wired only to its own: pinning
# `generic-pty` machine-wide makes a claude spawn fail outright with "runtime
# driver 'generic-pty' is not wired for harness 'claude-code'" — which reads in
# a probe's output as a session that produced nothing, not as a rig that asked
# for the wrong driver. Drive claude with `P2801_DRIVER=claude-pty`.
export PODIUM_RUNTIME_DRIVER="${P2801_DRIVER:-generic-pty}"
export PODIUM_LOG_LEVEL="${P2801_LOG_LEVEL:-debug}"

# Code under test: THIS worktree by default.
export PODIUM_DRIVE_REPO="${P2801_REPO:-/home/mgw/src/podium/.worktrees/issue-2801-bug-a-busy-terminal-session-shows-as-idl}"

# The harness binaries are not on a login path, and a daemon that cannot resolve
# one degrades the session to a generic PTY — which on THIS rig is the arm we
# asked for, so the degradation would be invisible. `phase-probe.ts` therefore
# prints the bound driverId for every session it drives.
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"

mkdir -p "$PODIUM_STATE_DIR"
chmod 700 "$PODIUM_DRIVE_BASE"
