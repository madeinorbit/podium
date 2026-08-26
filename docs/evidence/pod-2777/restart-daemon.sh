#!/usr/bin/env bash
# Restart ONLY the daemon of the p2777 instance, leaving the server alone.
#
#   bash docs/evidence/pod-2777/restart-daemon.sh
#
# This is the A7a row's whole apparatus. It is a separate script rather than
# inline in the probe so that the restart a person would do by hand and the
# restart the probe measures are the same act.
#
# THE SERVER IS DELIBERATELY LEFT RUNNING. A7a asks whether a session survives
# a DAEMON restart — the daemon is where the agent drivers live, and taking the
# server down too would also drop every client socket, so a pass would no longer
# distinguish "the session survived" from "the client reconnected to a rebuilt
# world". One process, one variable.
#
# It prints the OLD and NEW pids, and the probe REFUSES if they are equal:
# "survived a restart" measured across a daemon that never restarted is the
# purest vacuous pass there is, and this epic has shipped two of those.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
PIDFILE="$PODIUM_DRIVE_BASE/daemon.pid"
OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
[ -n "$OLD" ] || { echo "no daemon.pid — bring the rig up first" >&2; exit 2; }

echo "OLD_DAEMON_PID=$OLD"
kill "$OLD" 2>/dev/null || true
for _ in $(seq 1 60); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.25; done
kill -9 "$OLD" 2>/dev/null || true
# Confirm it is really gone before starting the replacement: two daemons on one
# instance serve sessions from processes nothing in this rig ever checked.
kill -0 "$OLD" 2>/dev/null && { echo "old daemon $OLD would not die" >&2; exit 3; }

cd "$PODIUM_DRIVE_REPO"
export PODIUM_WEB_DIR="$PODIUM_DRIVE_REPO/apps/web/dist"
nohup bun --conditions=@podium/source scripts/daemon.ts >>"$LOGS/daemon.log" 2>&1 &
NEW=$!
echo "$NEW" > "$PIDFILE"
git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD > "$PODIUM_DRIVE_BASE/daemon.sha"
echo "NEW_DAEMON_PID=$NEW"

# Wait for it to announce that it reconnected, rather than sleeping a guess.
for _ in $(seq 1 120); do
  if tail -40 "$LOGS/daemon.log" | grep -q "podium daemon up: connected"; then
    echo "DAEMON_RECONNECTED=1"
    exit 0
  fi
  sleep 1
done
echo "DAEMON_RECONNECTED=0" >&2
exit 4
