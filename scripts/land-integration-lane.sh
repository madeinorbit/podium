#!/bin/sh
# Coordinator landing guard (companion to scripts/guard-integration-branch.sh).
#
# Usage: land-integration-lane.sh <verified-sha> <lane-branch> [integration-branch]
#   <verified-sha>  the lane tip SHA the coordinator verified in an isolated checkout
#
# Merges <lane-branch> ff-only into the current branch (run in the integration worktree with
# the integration branch checked out), then asserts the tip equals <verified-sha>. A mismatch
# means someone moved the ref between verification and landing: stop and investigate.
# (The pre-commit guard is what stops a lane from moving the ref unreviewed in the first
# place; this catches a move made from another worktree or by a process without the hook.)
set -u
verified=${1:?usage: land-integration-lane.sh <verified-sha> <lane-branch> [integration-branch]}
lane=${2:?usage: land-integration-lane.sh <verified-sha> <lane-branch> [integration-branch]}
integ=${3:-$(git symbolic-ref --short HEAD 2>/dev/null)}
git merge --ff-only "$lane"
actual=$(git rev-parse "$integ")
if [ "$actual" != "$verified" ]; then
  echo "LANDING REFUSED: $integ is $actual, expected verified $verified." >&2
  echo "Someone moved the ref between verification and landing — investigate before retrying." >&2
  exit 1
fi
echo "landed $lane at $actual (matches verified $verified)"
