#!/usr/bin/env bash
# Wait for git to be quiescent before the redeploy restart picks up source.
# A fast-forward merge writes .git/logs/HEAD (which triggers podium-redeploy.path)
# while it still holds .git/index.lock for the working-tree checkout; under load the
# restart can beat the checkout and boot STALE source. Block until the lock clears.
set -u
repo="${1:?usage: redeploy-wait.sh <repo-root>}"
lock="$repo/.git/index.lock"
timeout="${REDEPLOY_WAIT_TIMEOUT:-30}"   # seconds; cap so a stuck lock can't wedge redeploy
settle="${REDEPLOY_WAIT_SETTLE:-0.5}"     # filesystem-flush grace once the lock is gone
deadline=$(( $(date +%s) + timeout ))
while [ -e "$lock" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[redeploy-wait] index.lock still present after ${timeout}s — proceeding anyway" >&2
    break
  fi
  sleep 0.1
done
sleep "$settle"
exit 0
