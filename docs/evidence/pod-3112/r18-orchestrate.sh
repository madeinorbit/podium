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
verify_a7b() {
  local reading="$BASE/r18-reading.json" log="$BASE/r18-run.log"
  if [ ! -f "$reading" ]; then
    cat "$log" 2>/dev/null || true
    echo "refusing: A7b reading absent after runner exit" >&2
    return 4
  fi
  cat "$reading"
  cat "$log" 2>/dev/null || true
  python3 -c 'import json,sys; x=json.load(open(sys.argv[1])); a=x.get("a7b") or {}; views=a.get("views") or {}; recall=a.get("recall") or {}; provider=a.get("provider") or {}; flags=("sameProviderSession","sameProcessKey","newPid","sameSession","sameCreatedAt","sameResume"); times=("viewerReleasedAt","hibernateAt","providerGoneAt","resurrectAt"); ok=x.get("verdict")=="PASS" and a.get("verdict")=="PASS" and all(a.get(k) is True for k in flags) and all(isinstance(a.get(k),str) and a.get(k) for k in times) and views.get("native") is True and views.get("chat") is True and recall.get("remembered") is True and provider.get("exact") is True; print("A7B_PASS_CONTROLLED" if ok else "REFUSED: incomplete or non-PASS A7b reading", file=sys.stdout if ok else sys.stderr); raise SystemExit(0 if ok else 4)' "$reading"
}

if [ "$MODE" = continue-a7b ]; then
  [ -f "$BASE/a7a-ready" ] || { echo "refusing: A7a checkpoint absent" >&2; exit 2; }
  runner_alive || { echo "refusing: detached r18 runner absent" >&2; exit 2; }
  touch "$BASE/a7a-continue"
  for _ in $(seq 1 1440); do
    runner_alive || { verify_a7b; exit $?; }
    sleep 0.25
  done
  echo "refusing: A7b runner timeout" >&2
  exit 3
fi
# Successful continuation is emitted only by verify_a7b: A7B_PASS_CONTROLLED.

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
