#!/usr/bin/env bash
# Isolated real-runtime environment for the POD-2920 A1b proof.
# Source this file; it deliberately reuses the established POD-2777 lifecycle
# while selecting a new instance, state root, endpoint triplet, and bookkeeping
# directory. Product state paths remain derived by the named-instance runtime.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

export P2777_INSTANCE="qpos2920"
export P2777_BASE="/tmp/pod-2920-qpos"
export P2777_PORT="19920"
export P2777_HOOK_PORT="46920"
export P2777_RELAY_PORT="46921"
export P2777_REPO="$REPO"
export P2777_CONTRACT="1"
export P2777_STREAMING="1"
unset P2777_DRIVER

# shellcheck source=../pod-2777/drive-env.sh
source "$REPO/docs/evidence/pod-2777/drive-env.sh"

export POD2920_PIN="59e851a655a75d88e5f50906317dce7b06a5222e"
export POD2920_EVIDENCE="$REPO/docs/evidence/pod-2920"
mkdir -p "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs" "$POD2920_EVIDENCE/readings"
chmod 700 "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs"
