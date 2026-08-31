#!/usr/bin/env bash
# Keep the released headed A1a runtime, its children, and teardown inside one
# shell/tool lifetime. The tool boundary reaps children when this shell exits.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
RIG="$HERE/rig.sh"
DRIVE="$HERE/drive.ts"
BUN=/home/mgw/.bun/bin/bun
if [ "${P3110_ATOMIC_TEST_MODE:-0}" = 1 ]; then
  PROTECTED_MARKER="${P3110_ATOMIC_TEST_MARKER:?test marker is required}"
else
  PROTECTED_MARKER="${HOME:?HOME must be inherited}/.podium/instance.json"
fi
cleanup_armed=0
before_marker=

marker_snapshot() {
  local marker="$1"
  [ -f "$marker" ] || { printf '%s\n' "ATOMIC REFUSAL protected marker missing: $marker" >&2; return 1; }
  printf '%s %s\n' "$(sha256sum "$marker" | awk '{print $1}')" "$(stat -c '%s %i %Y' "$marker")"
}

run_down() {
  if [ "${P3110_ATOMIC_TEST_MODE:-0}" = 1 ]; then
    "$P3110_ATOMIC_TEST_RIG" down
  else
    bash "$RIG" down
  fi
}

finish() {
  local drive_rc=$? cleanup_rc=0 after_marker=
  trap - EXIT
  if [ "$cleanup_armed" -eq 1 ]; then
    run_down || cleanup_rc=90
  fi
  after_marker="$(marker_snapshot "$PROTECTED_MARKER")" || cleanup_rc=91
  if [ -n "$before_marker" ] && [ "$after_marker" != "$before_marker" ]; then
    printf '%s\n' "ATOMIC REFUSAL protected marker changed" >&2
    printf '%s\n' "before=$before_marker" "after=$after_marker" >&2
    cleanup_rc=92
  fi
  if [ "$cleanup_rc" -ne 0 ]; then exit "$cleanup_rc"; fi
  exit "$drive_rc"
}

require_live_pid() {
  local label="$1" pid_file="$2" pid
  [ -s "$pid_file" ] || { printf '%s\n' "ATOMIC REFUSAL missing $label pid receipt" >&2; return 1; }
  pid="$(cat "$pid_file")"
  case "$pid" in *[!0-9]*|'') printf '%s\n' "ATOMIC REFUSAL invalid $label pid receipt" >&2; return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || { printf '%s\n' "ATOMIC REFUSAL $label pid $pid is not live" >&2; return 1; }
  [ "$(readlink -f "/proc/$pid/cwd")" = "$REPO" ] || { printf '%s\n' "ATOMIC REFUSAL $label pid $pid has foreign cwd" >&2; return 1; }
  tr '\0' '\n' <"/proc/$pid/environ" | grep -Fx "PODIUM_INSTANCE=$P3110_INSTANCE" >/dev/null || {
    printf '%s\n' "ATOMIC REFUSAL $label pid $pid has foreign instance" >&2; return 1
  }
}

require_listener() {
  local port="$1"
  ss -ltnp | awk -v port=":$port" '$1 == "LISTEN" && index($4, port) == length($4)-length(port)+1 { found=1 } END { exit !found }' || {
    printf '%s\n' "ATOMIC REFUSAL no listener on derived port $port" >&2; return 1
  }
}

real_run() {
  : "${P3110_RUN_TOKEN:?P3110_RUN_TOKEN is required}"
  # shellcheck source=docs/evidence/pod-3110/rig-env.sh
  source "$HERE/rig-env.sh"
  [ "${P3110_CELLS:-}" = A1a ] || { printf '%s\n' 'ATOMIC REFUSAL P3110_CELLS must equal A1a' >&2; return 2; }
  [ -z "${PODIUM_RUNTIME_DRIVER:-}" ] || { printf '%s\n' 'ATOMIC REFUSAL PODIUM_RUNTIME_DRIVER is set' >&2; return 2; }
  before_marker="$(marker_snapshot "$PROTECTED_MARKER")"
  cleanup_armed=1
  trap finish EXIT

  bash "$RIG" up terminal
  require_live_pid server "$P3110_RUN_DIR/server.pid"
  require_live_pid daemon "$P3110_RUN_DIR/daemon.pid"
  local ports
  ports="$(env -u PODIUM_PORT -u PODIUM_STATE_DIR -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR PODIUM_INSTANCE="$P3110_INSTANCE" PODIUM_NO_RELAY=1 "$BUN" --conditions=@podium/source -e 'import { defaultInstancePorts } from "@podium/runtime/instance"; const p=defaultInstancePorts(process.env.PODIUM_INSTANCE); console.log(`${p.server} ${p.hook} ${p.agentRelay}`)')"
  local port
  for port in $ports; do
    case "$port" in 19797|32090) printf '%s\n' "ATOMIC REFUSAL reserved derived port $port" >&2; return 2 ;; esac
    require_listener "$port"
  done
  P3110_CELLS=A1a "$BUN" "$DRIVE" terminal
}

test_invocation() {
  local marker="$1" rig="$2" drive="$3"
  P3110_ATOMIC_TEST_MODE=1 P3110_ATOMIC_TEST_RIG="$rig" P3110_ATOMIC_TEST_MARKER="$marker" \
    bash "$0" --test-child "$drive"
}

static_self_test() {
  local root marker rig fail_drive mutate_drive rc original_marker mutate_stderr expected_protected old_instance new_instance old_state new_state ports
  root="$(mktemp -d)"
  trap 'rm -rf -- "$root"' RETURN
  marker="$root/instance.json"
  rig="$root/rig"
  fail_drive="$root/fail-drive"
  mutate_drive="$root/mutate-drive"
  mutate_stderr="$root/mutate.stderr"
  expected_protected="${HOME:?HOME must be inherited}/.podium/instance.json"
  [ "$PROTECTED_MARKER" = "$expected_protected" ] || { printf '%s\n' "STATIC SELF TEST protected path mismatch: $PROTECTED_MARKER" >&2; return 1; }
  [ -f "$PROTECTED_MARKER" ] || { printf '%s\n' "STATIC SELF TEST live protected marker missing: $PROTECTED_MARKER" >&2; return 1; }
  old_instance=p3110-grok-paired-a4a209c-r5
  new_instance=p3110-grok-paired-a4a209c-r6
  [ "$old_instance" != "$new_instance" ] || { printf '%s\n' 'STATIC SELF TEST instance ids collide' >&2; return 1; }
  old_state="$(env -u PODIUM_STATE_DIR -u XDG_STATE_HOME PODIUM_INSTANCE="$old_instance" "$BUN" --conditions=@podium/source -e 'import { instanceStateDir } from "@podium/runtime/instance"; console.log(instanceStateDir())')"
  new_state="$(env -u PODIUM_STATE_DIR -u XDG_STATE_HOME PODIUM_INSTANCE="$new_instance" "$BUN" --conditions=@podium/source -e 'import { instanceStateDir } from "@podium/runtime/instance"; console.log(instanceStateDir())')"
  [ "$old_state" != "$new_state" ] || { printf '%s\n' 'STATIC SELF TEST state roots collide' >&2; return 1; }
  [ ! -e "$new_state/instance.json" ] || { printf '%s\n' "STATIC SELF TEST new marker exists: $new_state/instance.json" >&2; return 1; }
  ports="$(env -u PODIUM_STATE_DIR PODIUM_INSTANCE="$new_instance" "$BUN" --conditions=@podium/source -e 'import { defaultInstancePorts } from "@podium/runtime/instance"; const p=defaultInstancePorts(process.env.PODIUM_INSTANCE); console.log(`${p.server},${p.hook},${p.agentRelay}`)')"
  printf '%s\n' '{"protected":true}' >"$marker"
  original_marker="$(sha256sum "$marker" | awk '{print $1}')"
  printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "$1" >>"$P3110_TEST_EVENTS"' >"$rig"
  printf '%s\n' '#!/bin/sh' 'exit 23' >"$fail_drive"
  printf '%s\n' '#!/bin/sh' 'printf "%s\\n" changed >>"$1"' 'printf "%s\\n" drive-succeeded >>"$P3110_TEST_EVENTS"' 'exit 0' >"$mutate_drive"
  chmod +x "$rig" "$fail_drive" "$mutate_drive"

  : >"$root/events"
  set +e
  P3110_TEST_EVENTS="$root/events" test_invocation "$marker" "$rig" "$fail_drive" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 23 ] || { printf '%s\n' "STATIC SELF TEST drive rc not propagated: $rc" >&2; return 1; }
  [ "$(sed -n '$p' "$root/events")" = down ] || { printf '%s\n' 'STATIC SELF TEST early failure skipped down' >&2; return 1; }

  printf '%s\n' '{"protected":true}' >"$marker"
  : >"$root/events"
  set +e
  P3110_TEST_EVENTS="$root/events" test_invocation "$marker" "$rig" "$mutate_drive" >/dev/null 2>"$mutate_stderr"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || { printf '%s\n' 'STATIC SELF TEST changed marker passed' >&2; return 1; }
  grep -Fx 'ATOMIC REFUSAL protected marker changed' "$mutate_stderr" >/dev/null || { printf '%s\n' 'STATIC SELF TEST exact marker-change refusal missing' >&2; return 1; }
  [ "$(sha256sum "$marker" | awk '{print $1}')" != "$original_marker" ] || { printf '%s\n' 'STATIC SELF TEST marker bytes did not change' >&2; return 1; }
  grep -Fx 'drive-succeeded' "$root/events" >/dev/null || { printf '%s\n' 'STATIC SELF TEST mutate child did not succeed' >&2; return 1; }
  [ "$(sed -n '$p' "$root/events")" = down ] || { printf '%s\n' 'STATIC SELF TEST marker change skipped down' >&2; return 1; }
  printf '%s\n' "ATOMIC_STATIC_SELF_TEST_OK protected-path=exact live-marker=exists old-new-instance=distinct old-new-state=distinct new-marker=absent ports=$ports early-drive-rc=23 down=invoked mutate-child=succeeded marker-bytes=changed exact-refusal=matched"
}

case "${1:-}" in
  --static-self-test) static_self_test ;;
  --test-child)
    [ "${P3110_ATOMIC_TEST_MODE:-0}" = 1 ] || exit 2
    before_marker="$(marker_snapshot "$PROTECTED_MARKER")"
    cleanup_armed=1
    trap finish EXIT
    "$2" "$PROTECTED_MARKER"
    ;;
  '') real_run ;;
  *) printf '%s\n' 'usage: run-headed-a1a.sh [--static-self-test]' >&2; exit 2 ;;
esac
