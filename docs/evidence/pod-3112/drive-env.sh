#!/usr/bin/env bash
# Static environment contract for the paired OpenCode release-tip drive.
# Source only after the coordinator explicitly releases launch.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
export P3112_INSTANCE="${P3112_INSTANCE:-p3112-oc-paired-r2}"
export P3112_BASE="${P3112_BASE:-/tmp/pod-3112-paired-r2}"
export P3112_PORT="${P3112_PORT:-20312}"
export P3112_HOOK_PORT="${P3112_HOOK_PORT:-47312}"
export P3112_RELAY_PORT="${P3112_RELAY_PORT:-47313}"
export P3112_REPO="$REPO"
export P3112_PIN_SHA="${P3112_PIN_SHA:-d35c7ef7b630730f727365f25323427c67614386}"
export P3112_OPENCODE_BIN="${P3112_OPENCODE_BIN:-/home/mgw/.opencode/bin/opencode}"
export P3112_OPENCODE_SHA256="${P3112_OPENCODE_SHA256:-d91e0d33676d0839f7cde87924cd4127ea88c9d6784eea9f009a7d08bdc60eeb}"
export PODIUM_INSTANCE="$P3112_INSTANCE"
export PODIUM_PORT="$P3112_PORT"
export PODIUM_HOOK_PORT="$P3112_HOOK_PORT"
export PODIUM_AGENT_RELAY_PORT="$P3112_RELAY_PORT"
export PODIUM_HOST=127.0.0.1
export PODIUM_DRIVE_BASE="$P3112_BASE"
export PODIUM_DRIVE_REPO="$P3112_REPO"
export PODIUM_NO_RELAY=1
export PODIUM_RUNTIME_CONTRACT=1
export PODIUM_CHAT_STREAMING=1
export PODIUM_LOG_LEVEL=debug
export PODIUM_PASSWORD="${PODIUM_PASSWORD:-p3112-oc-paired-r2}"
for key in PODIUM_STATE_DIR ABDUCO_SOCKET_DIR PODIUM_RUNTIME_DRIVER; do
  [ -z "${!key-}" ] || { echo "refusing: inherited $key must be absent" >&2; return 2 2>/dev/null || exit 2; }
done
[ -n "${HOME-}" ] || { echo "refusing: ambient HOME absent" >&2; return 2 2>/dev/null || exit 2; }
P3112_STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/podium/$PODIUM_INSTANCE"
export P3112_STATE_ROOT
PODIUM_RIG_STATE_ROOT="$P3112_STATE_ROOT"
export PODIUM_RIG_STATE_ROOT
export PATH="$(dirname "$P3112_OPENCODE_BIN"):$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
case "$PODIUM_INSTANCE:$PODIUM_PORT:$PODIUM_DRIVE_BASE" in
 default:*|operator:*|*:19797:*|*:32090:*|*:/home/mgw/.podium*) echo "refusing operator/default target" >&2; return 2 2>/dev/null || exit 2;;
esac
mkdir -p "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs" "$REPO/docs/evidence/pod-3112/readings" "$REPO/docs/evidence/pod-3112/pins"
chmod 700 "$PODIUM_DRIVE_BASE" "$PODIUM_DRIVE_BASE/probes" "$PODIUM_DRIVE_BASE/logs"
