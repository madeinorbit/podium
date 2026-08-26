# Isolation environment for the POD-2819 MAIN BASELINE instance.
#
# Source this, never execute it.
#
#   . docs/evidence/pod-2819/drive-env-main.sh
#
# WHY A SECOND INSTANCE AT ALL. POD-2777's rig answers "is the epic's build
# better or worse than itself in another arm". POD-2819's claude question is a
# different one — "is this cell already red on TODAY'S MAIN" — and main cannot
# be driven inside p2777: the state root at /tmp/pod-2777/state has been
# migrated by the epic's server, and pointing main's server at it would ask a
# build to read a schema from its own future. So: a different instance name, a
# different state root, a different port, and the main worktree as the code
# under test.
#
# Everything else is POD-2777's drive-env.sh unchanged, deliberately — the same
# scrubbing of the inherited session, the same durable-terminal containment, the
# same PATH ordering that decides which of this box's two codex binaries a
# daemon resolves. A baseline that differed from the rig in some fourth way
# would not be a baseline.

export PODIUM_INSTANCE=p2819
export PODIUM_DRIVE_BASE=/tmp/pod-2819
export PODIUM_STATE_DIR="$PODIUM_DRIVE_BASE/state"

# PORT BASE 19857. Distinct from the OPERATOR'S 19797 and from POD-2777's 19847,
# so this baseline and the rig it is compared against can be up at once.
export PODIUM_PORT=19857
export PODIUM_HOOK_PORT=46857
export PODIUM_AGENT_RELAY_PORT=46858
export PODIUM_HOST=127.0.0.1

# The product chooses durable-terminal paths from the named state root.
# This baseline deliberately leaves those choices untouched.
unset ABDUCO_SOCKET_DIR TMUX_TMPDIR

# Scrub the inherited session: this shell runs INSIDE a Podium session on the
# developer's default instance, and inheriting these routes CLI calls back into
# the live server.
unset PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY
unset PODIUM_AGENT_RELAY PODIUM_HOME PODIUM_WEB_DIR
export PODIUM_NO_RELAY=1
unset ABDUCO_SESSION ABDUCO_SOCKET
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# NO ARM KNOBS. main has no runtime contract and no driver preference to set —
# `PODIUM_RUNTIME_CONTRACT` and `PODIUM_RUNTIME_DRIVER` are read by code this
# epic adds. Exporting them here would look like a control and be nothing.
unset PODIUM_RUNTIME_CONTRACT PODIUM_RUNTIME_DRIVER
export PODIUM_LOG_LEVEL="${POD2819_LOG_LEVEL:-debug}"

# TODAY'S MAIN, in its own detached worktree.
export PODIUM_DRIVE_REPO="${POD2819_REPO:-/home/mgw/pod2819-main-baseline}"

export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$PATH"

mkdir -p "$PODIUM_STATE_DIR"
chmod 700 "$PODIUM_DRIVE_BASE"
