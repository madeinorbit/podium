#!/usr/bin/env bash
# Keep r18 detached across the evidence-commit checkpoint, then release A7b explicitly.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
MODE="${1:-start}"
BASE="$PODIUM_DRIVE_BASE"
PIDFILE="$BASE/r18.pid"
runner_alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

if [ "$MODE" = continue-a7b ]; then
  [ -f "$BASE/a7a-ready" ] || { echo "refusing: A7a checkpoint absent" >&2; exit 2; }
  runner_alive || { echo "refusing: detached r18 runner absent" >&2; exit 2; }
  touch "$BASE/a7a-continue"
  for _ in $(seq 1 1440); do
    runner_alive || { cat "$BASE/r18-run.log"; exit 0; }
    sleep 0.25
  done
  echo "refusing: A7b runner timeout" >&2
  exit 3
fi

[ "$MODE" = start ] || { echo "usage: $0 [start|continue-a7b]" >&2; exit 2; }
[ ! -e "$PIDFILE" ] || { echo "refusing: r18 pidfile already exists" >&2; exit 2; }
[ ! -e "$BASE/a7a-ready" ] && [ ! -e "$BASE/a7a-continue" ] || { echo "refusing: stale checkpoint marker" >&2; exit 2; }
nohup setsid env R18_INSTANCE="$P3112_INSTANCE" R18_BASE="$P3112_BASE" R18_CWD="${R18_CWD:?R18_CWD required}" R18_PORT="$P3112_PORT" R18_HOOK_PORT="$P3112_HOOK_PORT" R18_RELAY_PORT="$P3112_RELAY_PORT" R18_EPIC_PIN="$P3112_PIN_SHA" R18_WORKSPACE="${R18_WORKSPACE:?R18_WORKSPACE required}" PATH="$PATH" /home/mgw/.bun/bin/bun --conditions=@podium/source "$HERE/r18-continuity.ts" > "$BASE/r18-run.log" 2>&1 < /dev/null &
RIG_PID=$!
printf '%s\n' "$RIG_PID" > "$PIDFILE"

for _ in $(seq 1 720); do
  if [ -f "$BASE/restart-ready" ]; then
    OLD="$(cat "$BASE/daemon.pid")"
    bash "$HERE/restart-daemon.sh" > "$BASE/restart-command.log" 2>&1
    NEW="$(cat "$BASE/daemon.pid")"
    printf '{"oldPid":%s,"newPid":%s,"at":"%s"}\n' "$OLD" "$NEW" "$(date --iso-8601=seconds)" > "$BASE/restart-done"
    break
  fi
  runner_alive || break
  sleep 0.25
done

for _ in $(seq 1 960); do
  if [ -f "$BASE/a7a-ready" ]; then cat "$BASE/a7a-ready"; exit 0; fi
  if ! runner_alive; then cat "$BASE/r18-run.log"; exit 2; fi
  sleep 0.25
done
echo "refusing: A7a checkpoint timeout" >&2
exit 3
