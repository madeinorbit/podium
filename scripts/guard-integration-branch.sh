#!/bin/sh
# Guard: refuse direct commits on integrate/* branches from non-coordinator sessions.
#
# A lane once put work straight onto integrate/4414-single-harness-transport; the
# coordinator's ff-only merge then reported "Already up to date" and the bypass was silent.
# This hook turns the "never merge into the integration branch yourself" rule into a refusal
# at commit time. `git merge --ff-only` (the coordinator's landing) creates no commit, so it
# is unaffected by this hook.
#
# Tracked source — the live hook is machine-local and untracked. Install with:
#   cp scripts/guard-integration-branch.sh "$(git rev-parse --git-common-dir)/hooks/pre-commit"
#   cp scripts/guard-integration-branch.sh "$(git rev-parse --git-common-dir)/hooks/pre-merge-commit"
# (One clone-wide hooks dir covers every worktree of the clone; the branch check below scopes
# the refusal to integration branches only.)
#
# Identity: $PODIUM_ISSUE when set, else the bound issue of $PODIUM_SESSION_ID via
# `podium session status`. Outside any agent session (a human at a terminal) the hook allows
# the commit. `git commit --no-verify` still bypasses: this stops accidents, not malice.
branch=$(git symbolic-ref --short HEAD 2>/dev/null) || exit 0
case "$branch" in integrate/*|integration/*) ;; *) exit 0;; esac
epic=$(printf '%s' "$branch" | grep -o '[0-9][0-9]*' | head -n 1)
[ -n "$epic" ] || exit 0
mine=$(printf '%s' "${PODIUM_ISSUE:-}" | tr -cd '0-9')
if [ -z "$mine" ] && [ -n "${PODIUM_SESSION_ID:-}" ]; then
  mine=$(podium session status "$PODIUM_SESSION_ID" 2>/dev/null | grep -o 'issue #[0-9][0-9]*' | head -n 1 | tr -cd '0-9')
fi
if [ -z "${PODIUM_SESSION_ID:-}${PODIUM_AGENT_RELAY:-}${PODIUM_SESSION_RELAY:-}${PODIUM_ISSUE_RELAY:-}${PODIUM_ISSUE:-}" ]; then exit 0; fi
if [ "$mine" = "$epic" ]; then exit 0; fi
echo "Refused: direct commits to '$branch' are coordinator-only (epic $epic; your issue is '${mine:-unknown}')." >&2
echo "Commit on your own lane branch instead; the coordinator lands it after review." >&2
exit 1
