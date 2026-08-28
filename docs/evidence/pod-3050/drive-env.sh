#!/usr/bin/env bash
# Isolation environment for the POD-3050 Claude SDK tool-transcript drive.
# Source this; never execute it in the live operator session.
#
# A NAMED INSTANCE OF ITS OWN, with its own state root and its own ports. The
# neighbouring rigs on this box (p2777 :19847, p3036n :19946, and whatever holds
# :19956) each reap "the previous pair" through their own $PODIUM_DRIVE_BASE
# pidfiles, so sharing any of those numbers means one rig killing another and
# then writing its commit into the survivor's log.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

export P2777_INSTANCE="${P3050_INSTANCE:-p3050}"
export P2777_BASE="${P3050_BASE:-/tmp/pod-3050}"
export P2777_PORT="${P3050_PORT:-19966}"
export P2777_HOOK_PORT="${P3050_HOOK_PORT:-46966}"
export P2777_RELAY_PORT="${P3050_RELAY_PORT:-46967}"
export P2777_REPO="$REPO"
export P2777_CONTRACT="${P3050_CONTRACT:-1}"
export P2777_STREAMING="${P3050_STREAMING:-1}"
unset P2777_DRIVER
unset PODIUM_RUNTIME_DRIVER

# shellcheck source=../pod-2777/drive-env.sh
source "$REPO/docs/evidence/pod-2777/drive-env.sh"

export P3050_INSTANCE="$PODIUM_INSTANCE"
export P3050_BASE="$PODIUM_DRIVE_BASE"
export P3050_REPO="$REPO"
export P3050_STATE_ROOT="$PODIUM_RIG_STATE_ROOT"
export PODIUM_PASSWORD="${PODIUM_PASSWORD:-p3050}"
# EXPLICIT SDK ACCEPTANCE, AND NOTHING ELSE. This flag acknowledges the Agent
# SDK's terms; it is not an authentication step and copies no credential.
export PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1
export PODIUM_RUNTIME_CONTRACT="${P3050_CONTRACT:-1}"
export PODIUM_CHAT_STREAMING="${P3050_STREAMING:-1}"

mkdir -p "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs" "$REPO/docs/evidence/pod-3050/readings" "$REPO/docs/evidence/pod-3050/pins"
chmod 700 "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs"
