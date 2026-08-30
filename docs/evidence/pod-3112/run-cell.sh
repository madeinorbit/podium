#!/usr/bin/env bash
# Run one cell against the live p3112-oc-paired-r4 instance.
set -euo pipefail
assert_same_path_set() {
  local expected="$1" actual="$2"
  [ "$actual" = "$expected" ] || {
    echo "refusing staged path mismatch" >&2
    echo "expected:" >&2
    printf '%s\n' "$expected" >&2
    echo "actual:" >&2
    printf '%s\n' "$actual" >&2
    return 1
  }
}
if [ "${P3112_RECORDER_SELF_CHECK:-}" = staged-mismatch ]; then
  if assert_same_path_set "expected/path" "foreign/path"; then
    echo "negative staged-set check failed to reject mismatch" >&2
    exit 1
  fi
  echo "negative staged-set mismatch rejected"
  exit 0
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/drive-env.sh"
CELL="${1:?cell}"
DRIVER="${2:?opencode-server|default-headed}"
export PODIUM_PASSWORD="${PODIUM_PASSWORD:-p3112-oc-paired-r4}"
export PODIUM_PORT PODIUM_HOST PODIUM_DRIVE_BASE P3112_STATE_ROOT
cd "$PODIUM_DRIVE_REPO"
ENTRY_STATUS="$(git status --porcelain=v1 --untracked-files=all)"
[ -z "$ENTRY_STATUS" ] || {
  echo "refusing: per-cell drive requires a clean, unstaged worktree" >&2
  printf '%s\n' "$ENTRY_STATUS" >&2
  exit 2
}
echo "=== $(date --iso-8601=seconds) $DRIVER $CELL ==="
df -h / | tail -1
free -h | awk 'NR==2{print}'
uptime
stat -c 'live_opencode_cred_mtime=%y size=%s' "$HOME/.local/share/opencode/auth.json"
ISOLATED="$P3112_STATE_ROOT/agent-home/.local/share/opencode/auth.json"
[ -L "$ISOLATED" ] || { echo "refusing: isolated OpenCode credential is not a symlink" >&2; exit 2; }
echo "isolated_credential=symlink"
OUTPUT="$(bun --conditions=@podium/source "$HERE/drive.ts" "$CELL" "$DRIVER")"
printf '%s\n' "$OUTPUT"
MANIFEST_COUNT="$(printf '%s\n' "$OUTPUT" | awk -F '\t' '$1 == "P3112_ARTIFACTS" { count++ } END { print count+0 }')"
[ "$MANIFEST_COUNT" = 1 ] || { echo "refusing: drive emitted $MANIFEST_COUNT artifact manifests" >&2; exit 2; }
MANIFEST="$(printf '%s\n' "$OUTPUT" | awk -F '\t' '$1 == "P3112_ARTIFACTS" { print }')"
READING_PATH="$(printf '%s\n' "$MANIFEST" | cut -f2)"
PIN_PATH="$(printf '%s\n' "$MANIFEST" | cut -f3)"
ADJUDICATION_PATH="$(printf '%s\n' "$MANIFEST" | cut -f4)"
case "$READING_PATH" in docs/evidence/pod-3112/readings/"$DRIVER"."${CELL,,}".*.json) ;; *) echo "refusing unexpected reading path: $READING_PATH" >&2; exit 2;; esac
case "$PIN_PATH" in docs/evidence/pod-3112/pins/"$DRIVER"-"${CELL,,}"-*.json) ;; *) echo "refusing unexpected pin path: $PIN_PATH" >&2; exit 2;; esac
[ -f "$READING_PATH" ] || { echo "refusing missing exact reading: $READING_PATH" >&2; exit 2; }
[ -f "$PIN_PATH" ] || { echo "refusing missing exact pin: $PIN_PATH" >&2; exit 2; }
CANDIDATES=("$READING_PATH" "$PIN_PATH" docs/evidence/pod-3112/results.tsv)
if ! git diff --quiet -- docs/plans/pod-1761-results.tsv; then CANDIDATES+=(docs/plans/pod-1761-results.tsv); fi
if [ -n "$ADJUDICATION_PATH" ]; then
  case "$ADJUDICATION_PATH" in docs/evidence/pod-3112/*) ;; *) echo "refusing unexpected adjudication path: $ADJUDICATION_PATH" >&2; exit 2;; esac
  [ -f "$ADJUDICATION_PATH" ] || { echo "refusing missing explicit adjudication: $ADJUDICATION_PATH" >&2; exit 2; }
  CANDIDATES+=("$ADJUDICATION_PATH")
fi
git add -f -- "${CANDIDATES[@]}"
EXPECTED="$(printf '%s\n' "${CANDIDATES[@]}" | LC_ALL=C sort -u)"
ACTUAL="$(git diff --cached --name-only --diff-filter=ACMRT | LC_ALL=C sort -u)"
assert_same_path_set "$EXPECTED" "$ACTUAL" || exit 2
git diff --cached --check
git commit -m "evidence(opencode): record $DRIVER $CELL" -m "Podium-Issue: POD-3112"
