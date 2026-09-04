#!/usr/bin/env bash
# Run one cell against the live p3036 instance.
#   bash docs/evidence/pod-3036/run-cell.sh A1a claude-sdk
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
CELL="${1:?cell}"
DRIVER="${2:?claude-sdk|claude-pty}"
export PODIUM_PASSWORD="${PODIUM_PASSWORD:-p3036n}"
export PODIUM_PORT="$PODIUM_PORT"
export PODIUM_HOST="$PODIUM_HOST"
export PODIUM_DRIVE_BASE="$PODIUM_DRIVE_BASE"
export P3036_STATE_ROOT="$PODIUM_RIG_STATE_ROOT"
export P3036_PIN_SHA="${P3036_PIN_SHA:-c71b896a9504426ee6706a0623e9cb25e704cc98}"
unset PODIUM_WEB_DIR PODIUM_STATE_DIR PODIUM_AGENT_HOME ABDUCO_SOCKET_DIR TMUX_TMPDIR
cd "$PODIUM_DRIVE_REPO"
echo "=== $(date --iso-8601=seconds) $DRIVER $CELL ==="
df -h / | tail -1
free -h | awk 'NR==2{print}'
uptime
stat -c 'live_cred_mtime=%y size=%s' "$HOME/.claude/.credentials.json"
ISOLATED="$PODIUM_RIG_STATE_ROOT/agent-home/.claude/.credentials.json"
if [ -e "$ISOLATED" ]; then
  echo "refusing: isolated credential present at $ISOLATED" >&2
  exit 2
fi
echo "isolated_credential=absent"
bun --conditions=@podium/source "$HERE/drive.ts" "$CELL" "$DRIVER"
