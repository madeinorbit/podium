# Isolation environment for the POD-2290 view test-drive instance.
#
# Source this, never execute it — a subshell that exported these would leave
# the next command talking to the developer's LIVE instance.
#
#   . docs/evidence/pod-2290/drive-env.sh
#
# POD-2245's recipe (docs/operator-test-instance.md, docs/evidence/pod-2245/)
# re-cut for this issue's own instance, per the operator's rule that a
# UX-touching fix is driven live by the agent that wrote it. DIFFERENT
# instance name, state root and ports from POD-2245's `operator`, so the two
# can run side by side and no stale artifact of one can be read as the other.

# --- identity -------------------------------------------------------------
export PODIUM_INSTANCE=p2290

# The base contains only this rig's state, logs and scratch repository.
export PODIUM_DRIVE_BASE=/tmp/pod-2290

export PODIUM_STATE_DIR="$PODIUM_DRIVE_BASE/state"

# --- endpoints ------------------------------------------------------------
# The coordinator's ports, explicit rather than id-derived, and distinct from
# both the live instance and POD-2245's operator instance (19797/46797/46798).
export PODIUM_PORT=19807
export PODIUM_HOOK_PORT=46807
export PODIUM_AGENT_RELAY_PORT=46808

# LOOPBACK, unlike POD-2245's tailnet bind. That instance existed for a remote
# operator to touch; this one is driven from this box by a headless browser, so
# there is no reason to expose a credential-bearing test instance to a network.
export PODIUM_HOST=127.0.0.1

# --- durable-terminal selection ------------------------------------------
# Leave both variables unset. The named-instance runtime must choose the
# durable backend paths that an installed instance would use.

# --- scrub the inherited session ------------------------------------------
# This shell runs INSIDE a Podium session on the developer's default instance,
# which exports these; inheriting any of them routes CLI calls back into the
# live server. PODIUM_HOME/PODIUM_WEB_DIR point at the INSTALLED bundle, which
# would serve a stale web build instead of the one built from this branch —
# and this instance exists precisely to look at the web build.
unset PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY
unset PODIUM_AGENT_RELAY PODIUM_HOME PODIUM_WEB_DIR
unset ABDUCO_SESSION ABDUCO_SOCKET ABDUCO_SOCKET_DIR TMUX_TMPDIR
export PODIUM_NO_RELAY=1

# --- code under test ------------------------------------------------------
# THIS ISSUE'S OWN WORKTREE, not a detached pin. POD-2245 pinned deliberately
# so landing agents could not move the code under a running instance; here the
# code under test is the fix being written, and re-pinning after every edit is
# the opposite of the point. The tradeoff is that a restart is required to pick
# an edit up (server and daemon are long-lived bun processes, not watchers) —
# drive-up.sh is safe to re-run for exactly that.
export PODIUM_DRIVE_REPO=/home/mgw/src/podium/.worktrees/issue-2290-bug-native-view-stuck-on-headless-sessio

mkdir -p "$PODIUM_STATE_DIR"
chmod 700 "$PODIUM_DRIVE_BASE"
