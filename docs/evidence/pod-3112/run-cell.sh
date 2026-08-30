#!/usr/bin/env bash
# Run one cell against the live p3112-oc-paired-r4 instance.
#   bash docs/evidence/pod-3112/run-cell.sh A1a opencode-server
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
CELL="${1:?cell}"
DRIVER="${2:?opencode-server|default-headed}"
export PODIUM_PASSWORD="${PODIUM_PASSWORD:-p3112-oc-paired-r4}"
export PODIUM_PORT="$PODIUM_PORT"
export PODIUM_HOST="$PODIUM_HOST"
export PODIUM_DRIVE_BASE="$PODIUM_DRIVE_BASE"
export P3112_STATE_ROOT
cd "$PODIUM_DRIVE_REPO"
echo "=== $(date --iso-8601=seconds) $DRIVER $CELL ==="
df -h / | tail -1
free -h | awk 'NR==2{print}'
uptime
stat -c 'live_opencode_cred_mtime=%y size=%s' "$HOME/.local/share/opencode/auth.json"
ISOLATED="$P3112_STATE_ROOT/agent-home/.local/share/opencode/auth.json"
[ -L "$ISOLATED" ] || { echo "refusing: isolated OpenCode credential is not a symlink" >&2; exit 2; }
echo "isolated_credential=symlink"
bun --conditions=@podium/source "$HERE/drive.ts" "$CELL" "$DRIVER"
git -C "$PODIUM_DRIVE_REPO" add -f docs/evidence/pod-3112/readings docs/evidence/pod-3112/pins docs/evidence/pod-3112/results.tsv
git -C "$PODIUM_DRIVE_REPO" commit -m "evidence(opencode): record $DRIVER $CELL" -m "Podium-Issue: POD-3112"
