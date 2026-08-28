#!/usr/bin/env bash
# Sequential cells. One instance. Failures do not stop the batch.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER="${1:?driver}"
shift
for cell in "$@"; do
  echo
  echo "######## $DRIVER $cell $(date --iso-8601=seconds) ########"
  if ! bash "$HERE/run-cell.sh" "$cell" "$DRIVER"; then
    echo "RUN-CELL EXIT $? for $DRIVER $cell — continuing"
  fi
  stat -c 'live_cred_mtime=%y size=%s' "$HOME/.claude/.credentials.json"
  test ! -e "$PODIUM_RIG_STATE_ROOT/agent-home/.claude/.credentials.json" && echo isolated_credential=absent
done
echo "######## batch done $(date --iso-8601=seconds) ########"
