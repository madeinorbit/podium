#!/usr/bin/env bash
# Land this branch on the epic, ff-only, ONLY while holding the merge lock.
#
#   bash docs/evidence/pod-2777/land.sh
#
# WHY THIS EXISTS: I landed two commits while another session held the lock.
# Not because I skipped the check — I ran `podium merge-lock acquire`, it QUEUED
# me at position 1 rather than granting, and my next command ran the merge
# anyway. The check printed the right answer and nothing was gated on it.
#
# "Check the lock at the moment you act" is only worth something IF THE ACTION IS
# GATED ON THE CHECK. A step a human reads is not a gate. So this script:
#   - refuses unless the acquire actually GRANTED (queued is not granted);
#   - refuses a non-fast-forward rather than creating a merge commit;
#   - releases in a trap, so an error between acquire and release still frees it;
#   - and cancels the queue slot if it ends up queued, because a stale slot can
#     later grant the lock to a process that is gone.
set -euo pipefail

EPIC="issue/1761-agent-runtime"
LOCK="merge:$EPIC"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || { echo "detached HEAD — refusing" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "working tree dirty — commit first, reset --hard discards it" >&2; exit 2; }

git fetch -q --all 2>/dev/null || true
BEHIND="$(git rev-list --count "HEAD..$EPIC")"
[ "$BEHIND" = "0" ] || { echo "behind $EPIC by $BEHIND — rebase first" >&2; exit 2; }
AHEAD="$(git rev-list --count "$EPIC..HEAD")"
[ "$AHEAD" != "0" ] || { echo "nothing to land" >&2; exit 0; }

# --- THE GATE. Acquire must GRANT, not queue. ------------------------------
out="$(podium merge-lock acquire --branch "$EPIC" --ttl 10m 2>&1 || true)"
case "$out" in
  *acquired*)
    ;;
  *queued*)
    echo "LOCK IS HELD — I was queued, not granted. Leaving the queue and refusing to land." >&2
    echo "$out" >&2
    podium lock cancel "$LOCK" >/dev/null 2>&1 || true
    exit 3
    ;;
  *)
    echo "could not acquire $LOCK — refusing to land:" >&2
    echo "$out" >&2
    exit 3
    ;;
esac
# Release even if the merge below fails, so a crash does not strand the branch.
trap 'podium merge-lock release --branch "$EPIC" >/dev/null 2>&1 || true' EXIT

# --- land, ff-only, into wherever the epic is checked out ------------------
WT="$(git worktree list --porcelain | awk -v b="refs/heads/$EPIC" '/^worktree /{w=$2} $0=="branch "b{print w}')"
if [ -n "$WT" ]; then
  git -C "$WT" merge --ff-only "$BRANCH"
else
  git merge-base --is-ancestor "$EPIC" HEAD
  git update-ref "refs/heads/$EPIC" HEAD
fi

echo "landed $AHEAD commit(s); $EPIC is now $(git rev-parse --short=9 "$EPIC")"
