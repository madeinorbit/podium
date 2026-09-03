#!/usr/bin/env bash
# POD-2873 runtime evidence: one isolated, split server/daemon drive per arm.
#
# The product keeps its natural HOME and derives state from it.  A mount
# namespace supplies an empty directory at that natural path so the default
# arm cannot touch the operator's live ~/.podium.  HOME itself is not changed,
# and neither PODIUM_STATE_DIR nor any durable-socket override is set.
#
# Fixed arms:
#   custom-default  PODIUM_INSTANCE=default + a distinct PODIUM_AGENT_HOME
#   named           PODIUM_INSTANCE=pod2873n + product-derived agent home
#   default-safe    PODIUM_INSTANCE=default + no agent-home override
#
# Optional control:
#   POD2873_CONTROL_REPO=/path/to/pre-fix/checkout bash drive.sh
#
# Every arm is a separate process and working directory.  The output is copied
# into readings/ so the committed evidence includes the direct row and socket
# readings, not only a prose conclusion.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_REPO="$(cd "$HERE/../../.." && pwd)"
NATURAL_UID="$(id -u)"
NATURAL_HOME="${HOME:?the driver must be started from a login environment}"
EVIDENCE_DIR="${POD2873_EVIDENCE_DIR:-$HERE/readings}"
RUN_ROOT="${POD2873_RUN_ROOT:-$(mktemp -d /tmp/pod-2873-drive-XXXXXX)}"
CONTROL_REPO="${POD2873_CONTROL_REPO:-}"

mkdir -p "$EVIDENCE_DIR" "$RUN_ROOT"

if [[ -n "$CONTROL_REPO" && ! -d "$CONTROL_REPO" ]]; then
  echo "control checkout does not exist: $CONTROL_REPO" >&2
  exit 2
fi

run_arm() {
  local arm="$1"
  local expect="$2"
  local source_repo="$3"
  local instance="$4"
  local agent_mode="$5"
  local port="$6"
  local hook_port="$7"
  local relay_port="$8"
  local arm_root="$RUN_ROOT/$arm"
  local ns_root=/tmp/pod2873-arm
  local source_sha
  local source_target
  local agent_home
  local log="$EVIDENCE_DIR/$arm.log"

  source_sha="$(git -C "$source_repo" rev-parse HEAD)"
  source_target="$ns_root/repo"
  agent_home="$ns_root/custom-agent-home"

  mkdir -p "$arm_root/home/.bun" "$arm_root/repo"
  # The driver copies this staged binary into the product cache after it has
  # claimed the state root, so named-instance adoption remains a real check.
  cp --preserve=mode "$NATURAL_HOME/.podium/bin/abduco" "$arm_root/abduco"
  if [[ "$source_repo" != "$CURRENT_REPO" ]]; then
    # A detached git worktree has no ignored node_modules directory.  Create
    # the mount point in the source before the whole checkout is mounted; the
    # fixed checkout's links then resolve against this older source tree.
    mkdir -p "$source_repo/node_modules" "$arm_root/control"
  fi

  local -a command=(
    env
    -u PODIUM_STATE_DIR
    -u ABDUCO_SOCKET_DIR
    -u TMUX_TMPDIR
    -u PODIUM_SESSION_ID
    -u PODIUM_SESSION_INSTANCE
    -u PODIUM_SESSION_RELAY
    -u PODIUM_AGENT_RELAY
    -u ABDUCO_SESSION
    -u ABDUCO_SOCKET
    -u PODIUM_AGENT_HOME
    PODIUM_INSTANCE="$instance"
    PODIUM_PORT="$port"
    PODIUM_HOOK_PORT="$hook_port"
    PODIUM_AGENT_RELAY_PORT="$relay_port"
    PODIUM_HOST=127.0.0.1
    PODIUM_PASSWORD=pod2873
    PODIUM_NO_RELAY=1
    PODIUM_NO_SCOPE=1
    PODIUM_LOG_LEVEL=debug
    POD2873_ARM="$arm"
    POD2873_EXPECT="$expect"
    POD2873_ARM_ROOT="$ns_root"
    POD2873_SOURCE_REPO="$source_target"
    POD2873_SOURCE_SHA="$source_sha"
    bwrap
    --die-with-parent
    --ro-bind /
    /
    --tmpfs
    /tmp
    --dir
    "$ns_root"
    --tmpfs
    "/run/user/$NATURAL_UID"
    --bind
    "$arm_root"
    "$ns_root"
    --proc
    /proc
    --dev
    /dev
    --bind
    "$arm_root/home"
    "$NATURAL_HOME"
    --ro-bind
    "$NATURAL_HOME/.bun"
    "$NATURAL_HOME/.bun"
    --ro-bind
    "$CURRENT_REPO"
    "$source_target"
    --chdir
    "$source_target"
    --unsetenv
    PODIUM_STATE_DIR
    --unsetenv
    ABDUCO_SOCKET_DIR
    --unsetenv
    TMUX_TMPDIR
    --unsetenv
    PODIUM_SESSION_ID
    --unsetenv
    PODIUM_SESSION_INSTANCE
    --unsetenv
    PODIUM_SESSION_RELAY
    --unsetenv
    PODIUM_AGENT_RELAY
    --unsetenv
    ABDUCO_SESSION
    --unsetenv
    ABDUCO_SOCKET
  )

  if [[ "$source_repo" != "$CURRENT_REPO" ]]; then
    command+=(
      --ro-bind
      "$source_repo"
      "$ns_root/control"
      --ro-bind
      "$CURRENT_REPO/node_modules"
      "$ns_root/control/node_modules"
    )
    # The control source path is mounted read-only at its own path; the driver
    # receives that path instead of the fixed source target below.
    command+=(--setenv POD2873_SOURCE_REPO "$ns_root/control")
  fi

  if [[ "$agent_mode" == custom ]]; then
    command+=(--setenv PODIUM_AGENT_HOME "$agent_home")
  fi

  command+=(
    --
    "$NATURAL_HOME/.bun/bin/bun"
    "$source_target/docs/evidence/pod-2873/drive.ts"
  )

  echo "=== driving $arm (source $source_sha) ==="
  set +e
  "${command[@]}" 2>&1 | tee "$log"
  local status="${PIPESTATUS[0]}"
  set -e
  if [[ "$status" != 0 ]]; then
    echo "arm $arm failed with status $status; reading kept at $log" >&2
    return "$status"
  fi
}

if [[ -n "$CONTROL_REPO" ]]; then
  run_arm control-custom legacy "$CONTROL_REPO" default custom 21740 21840 21841
fi

run_arm fixed-custom-default fixed "$CURRENT_REPO" default custom 21741 21841 21842
run_arm fixed-named fixed "$CURRENT_REPO" pod2873n derived 21742 21842 21843
run_arm fixed-default-safe fixed "$CURRENT_REPO" default derived 21743 21843 21844

echo
echo "runtime evidence written under $EVIDENCE_DIR"
echo "temporary process roots were $RUN_ROOT"
