#!/usr/bin/env bash
# Isolation environment for the POD-3036 Claude SDK vs PTY acceptance instance.
# Source this; never execute it in the live operator session.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

export P2777_INSTANCE="${P3036_INSTANCE:-p3036n}"
export P2777_BASE="${P3036_BASE:-/tmp/pod-3036n}"
export P2777_PORT="${P3036_PORT:-19946}"
export P2777_HOOK_PORT="${P3036_HOOK_PORT:-46946}"
export P2777_RELAY_PORT="${P3036_RELAY_PORT:-46947}"
export P2777_REPO="$REPO"
export P2777_CONTRACT="${P3036_CONTRACT:-1}"
export P2777_STREAMING="${P3036_STREAMING:-1}"
unset P2777_DRIVER
unset PODIUM_RUNTIME_DRIVER

# shellcheck source=../pod-2777/drive-env.sh
source "$REPO/docs/evidence/pod-2777/drive-env.sh"

export P3036_INSTANCE="$PODIUM_INSTANCE"
export P3036_BASE="$PODIUM_DRIVE_BASE"
export P3036_REPO="$REPO"
export P3036_STATE_ROOT="$PODIUM_RIG_STATE_ROOT"
export PODIUM_PASSWORD="${PODIUM_PASSWORD:-p3036n}"
export PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1
export PODIUM_RUNTIME_CONTRACT="${P3036_CONTRACT:-1}"
export PODIUM_CHAT_STREAMING="${P3036_STREAMING:-1}"

mkdir -p "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs" "$REPO/docs/evidence/pod-3036/readings" "$REPO/docs/evidence/pod-3036/pins"
chmod 700 "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs"
