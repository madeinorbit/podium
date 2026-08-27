#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
export P2919_CODE_PIN="${P2919_CODE_PIN:-$(git -C "$REPO" rev-parse HEAD)}"
source "$HERE/drive-env.sh"
echo "P2919_CODE_PIN=$P2919_CODE_PIN"
echo "P2919_PROBE_CWD=(created per cell)"
exec bash "$REPO/docs/evidence/pod-2777/drive-up.sh"
