#!/usr/bin/env bash
# Isolation environment for the POD-3057 SDK transcript-read rig.
# Source this; never execute it in the live operator session.
#
# Its own instance name, state root and ports, because p3047n is up and being
# driven by another session right now — two drives on one identity reap each
# other's processes and each writes its commit into the other's log.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

export P2777_INSTANCE="${P3057_INSTANCE:-p3057n}"
export P2777_BASE="${P3057_BASE:-/tmp/pod-3057n}"
export P2777_PORT="${P3057_PORT:-19958}"
export P2777_HOOK_PORT="${P3057_HOOK_PORT:-46960}"
export P2777_RELAY_PORT="${P3057_RELAY_PORT:-46961}"
export P2777_REPO="$REPO"
export P2777_CONTRACT="${P3057_CONTRACT:-1}"
export P2777_STREAMING="${P3057_STREAMING:-1}"
unset P2777_DRIVER
unset PODIUM_RUNTIME_DRIVER

# shellcheck source=../pod-2777/drive-env.sh
source "$REPO/docs/evidence/pod-2777/drive-env.sh"

export P3057_INSTANCE="$PODIUM_INSTANCE"
export P3057_BASE="$PODIUM_DRIVE_BASE"
export P3057_REPO="$REPO"
export P3057_STATE_ROOT="$PODIUM_RIG_STATE_ROOT"
export PODIUM_PASSWORD="${PODIUM_PASSWORD:-p3057n}"
export PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1
export PODIUM_RUNTIME_CONTRACT="${P3057_CONTRACT:-1}"
export PODIUM_CHAT_STREAMING="${P3057_STREAMING:-1}"

mkdir -p "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs" "$REPO/docs/evidence/pod-3057/readings"
chmod 700 "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs"
