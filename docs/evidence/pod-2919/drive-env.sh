#!/usr/bin/env bash
# POD-2919: one isolated, named opencode acceptance rig.
# Source this file; do not execute it in the caller's live session.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export P2777_INSTANCE="${P2919_INSTANCE:-oc2919}"
export P2777_BASE="${P2919_BASE:-/tmp/pod-2919}"
export P2777_PORT="${P2919_PORT:-19857}"
export P2777_HOOK_PORT="${P2919_HOOK_PORT:-46857}"
export P2777_RELAY_PORT="${P2919_RELAY_PORT:-46858}"
export P2777_REPO="$REPO"
export P2777_CONTRACT="${P2919_CONTRACT:-1}"
export P2777_STREAMING="${P2919_STREAMING:-1}"
if [ -n "${P2919_ARM_DRIVER:-}" ]; then
  export P2777_DRIVER="$P2919_ARM_DRIVER"
else
  unset P2777_DRIVER
fi

# The product chooses the named state root itself. This is bookkeeping used by
# the rig only; it is deliberately not a product path override.
source "$REPO/docs/evidence/pod-2777/drive-env.sh"

export P2919_INSTANCE="$PODIUM_INSTANCE"
export P2919_BASE="$PODIUM_DRIVE_BASE"
export P2919_REPO="$REPO"
export P2919_STATE_ROOT="$PODIUM_RIG_STATE_ROOT"
export P2919_CODE_PIN="${P2919_CODE_PIN:-}"
export P2919_PROBE_CWD="${P2919_PROBE_CWD:-}"
mkdir -p "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs" "$REPO/docs/evidence/pod-2919/readings"
chmod 700 "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs"
