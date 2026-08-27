#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cell="${1:?cell id, e.g. A1a}"
arm="${2:-headless}"
case "$cell" in A1a|A1b|A1c|A2b|A3|A5|A6a|A7a|A9|A10) ;; *) echo "unknown cell $cell" >&2; exit 2;; esac
case "$arm" in headless) driver=''; family=server;; terminal) driver=generic-pty; family=terminal;; *) echo "unknown arm $arm" >&2; exit 2;; esac
case "$cell:$arm" in
  A6a:headless|A1a:terminal|A1b:terminal|A1c:terminal|A2b:terminal|A3:terminal|A5:terminal|A7a:terminal|A9:terminal) echo "cell/arm not in scope" >&2; exit 2;;
esac
export P2919_ARM_DRIVER="$driver"
export P2919_EXPECTED_DRIVER="${driver:+generic-pty}"
[ -n "$driver" ] || export P2919_EXPECTED_DRIVER=opencode-server
export P2919_EXPECTED_FAMILY="$family"
export P2919_PROBE_CWD="$PODIUM_DRIVE_BASE/probes/${arm,,}-${cell,,}"
mkdir -p "$P2919_PROBE_CWD"
chmod 700 "$P2919_PROBE_CWD"
source "$HERE/drive-env.sh"
echo "DATE $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "CELL=$cell ARM=$arm INSTANCE=$PODIUM_INSTANCE"
echo "REQUESTED_CWD=$P2919_PROBE_CWD"
free -h
df -h "$REPO"
cd "$P2919_PROBE_CWD"
exec /home/mgw/.bun/bin/bun --conditions=@podium/source "$HERE/drive.ts" "$cell" "$arm"
