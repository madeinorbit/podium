#!/usr/bin/env bash
# Sequential cells. One instance. Failures do not stop the batch.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
DRIVER="${1:?driver}"
shift
for cell in "$@"; do
  echo
  echo "######## $DRIVER $cell $(date --iso-8601=seconds) ########"
  if ! bash "$HERE/run-cell.sh" "$cell" "$DRIVER"; then
    echo "RUN-CELL EXIT $? for $DRIVER $cell — continuing"
  fi
  stat -c 'live_cred_mtime=%y size=%s' "$HOME/.local/share/opencode/auth.json"
  test ! -e "$P3112_STATE_ROOT/agent-home/.local/share/opencode/auth.json" && echo isolated_credential=symlink
done
echo "######## batch done $(date --iso-8601=seconds) ########"
