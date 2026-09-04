#!/usr/bin/env bash
# Keep the released headed A1a runtime, its children, and teardown inside one
# shell/tool lifetime. The tool boundary reaps children when this shell exits.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
RIG="$HERE/rig.sh"
DRIVE="$HERE/drive.ts"
BUN=/home/mgw/.bun/bin/bun
cleanup_armed=0

run_down() {
  if [ "${P3110_ATOMIC_TEST_MODE:-0}" = 1 ]; then
    "$P3110_ATOMIC_TEST_RIG" down
  else
    bash "$RIG" down
  fi
}

finish() {
  local drive_rc=$? cleanup_rc=0
  trap - EXIT
  if [ "$cleanup_armed" -eq 1 ]; then
    run_down || cleanup_rc=90
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
  local derived_state
  derived_state="$(env -u PODIUM_PORT -u PODIUM_STATE_DIR -u PODIUM_AGENT_HOME -u PODIUM_HOME -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR -u XDG_STATE_HOME PODIUM_INSTANCE="$P3110_INSTANCE" PODIUM_NO_RELAY=1 "$BUN" --conditions=@podium/source -e 'import { instanceStateDir } from "@podium/runtime/instance"; console.log(instanceStateDir())')"
  [ "$P3110_STATE_DIR" = "$derived_state" ] || {
    printf '%s\n' "ATOMIC REFUSAL noncanonical named state root: got=$P3110_STATE_DIR want=$derived_state" >&2; return 2
  }
  [ ! -e "$P3110_STATE_DIR" ] || { printf '%s\n' "ATOMIC REFUSAL fresh r9 whole state root already exists: $P3110_STATE_DIR" >&2; return 2; }
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
  local root marker rig fail_drive mutate_drive rc original_marker mutate_stderr expected_protected old_instance new_instance old_state new_state derived_new_state old_ports new_ports port
  root="$(mktemp -d)"
  trap 'rm -rf -- "$root"' RETURN
  marker="$root/protected-root-file"
  rig="$root/rig"
  fail_drive="$root/fail-drive"
  mutate_drive="$root/mutate-drive"
  mutate_stderr="$root/mutate.stderr"
  if [ "${P3110_ATOMIC_TEST_MODE:-0}" = 1 ]; then
    [ -f "${P3110_ATOMIC_TEST_MARKER:?test marker is required}" ] || { printf '%s\n' "STATIC SELF TEST fixture file missing" >&2; return 1; }
  fi
  new_instance=p3110-grok-paired-2ac84c5-r9
  old_instance=p3110-grok-2ac84c5-control
  new_state="${P3110_STATE_DIR:?P3110_STATE_DIR is required}"
  [ ! -e "$new_state" ] || { printf '%s\n' "STATIC SELF TEST new state root exists before derivations: $new_state" >&2; return 1; }
  [ "$old_instance" != "$new_instance" ] || { printf '%s\n' 'STATIC SELF TEST instance ids collide' >&2; return 1; }
  old_state="$(env -u PODIUM_STATE_DIR -u XDG_STATE_HOME PODIUM_INSTANCE="$old_instance" "$BUN" --conditions=@podium/source -e 'import { instanceStateDir } from "@podium/runtime/instance"; console.log(instanceStateDir())')"
  derived_new_state="$(env -u PODIUM_STATE_DIR -u XDG_STATE_HOME PODIUM_INSTANCE="$new_instance" "$BUN" --conditions=@podium/source -e 'import { instanceStateDir } from "@podium/runtime/instance"; console.log(instanceStateDir())')"
  [ "$derived_new_state" = "$new_state" ] || { printf '%s\n' "STATIC SELF TEST expected/derived new state mismatch: $new_state != $derived_new_state" >&2; return 1; }
  [ "$old_state" != "$new_state" ] || { printf '%s\n' 'STATIC SELF TEST state roots collide' >&2; return 1; }
  old_ports="$(env -u PODIUM_STATE_DIR PODIUM_INSTANCE="$old_instance" "$BUN" --conditions=@podium/source -e 'import { defaultInstancePorts } from "@podium/runtime/instance"; const p=defaultInstancePorts(process.env.PODIUM_INSTANCE); console.log(`${p.server},${p.hook},${p.agentRelay}`)')"
  new_ports="$(env -u PODIUM_STATE_DIR PODIUM_INSTANCE="$new_instance" "$BUN" --conditions=@podium/source -e 'import { defaultInstancePorts } from "@podium/runtime/instance"; const p=defaultInstancePorts(process.env.PODIUM_INSTANCE); console.log(`${p.server},${p.hook},${p.agentRelay}`)')"
  [ "$old_ports" != "$new_ports" ] || { printf '%s\n' 'STATIC SELF TEST old/new port tuples collide' >&2; return 1; }
  IFS=, read -r -a new_port_tuple <<<"$new_ports"
  [ "${#new_port_tuple[@]}" -eq 3 ] || { printf '%s\n' "STATIC SELF TEST malformed new port tuple: $new_ports" >&2; return 1; }
  [ "${new_port_tuple[0]}" != "${new_port_tuple[1]}" ] && [ "${new_port_tuple[0]}" != "${new_port_tuple[2]}" ] && [ "${new_port_tuple[1]}" != "${new_port_tuple[2]}" ] || { printf '%s\n' "STATIC SELF TEST duplicate new ports: $new_ports" >&2; return 1; }
  for port in "${new_port_tuple[@]}"; do
    case "$port" in 19797|32090) printf '%s\n' "STATIC SELF TEST reserved new port: $port" >&2; return 1 ;; esac
    if ss -ltn | awk -v suffix=":$port" '$1 == "LISTEN" && index($4, suffix) == length($4)-length(suffix)+1 { found=1 } END { exit !found }'; then
      printf '%s\n' "STATIC SELF TEST new port has listener: $port" >&2; return 1
    fi
  done
  [ ! -e "$new_state" ] || { printf '%s\n' "STATIC SELF TEST new state root exists after helpers: $new_state" >&2; return 1; }
  printf '%s\n' "ATOMIC_STATIC_SELF_TEST_OK canonical-state=resolver-equal old-new-instance=distinct old-new-state=distinct whole-root-before=absent whole-root-after=absent old-new-ports=distinct new-ports-pairwise=distinct new-ports-nonreserved=yes new-ports-listeners=zero ports=$new_ports"
}

case "${1:-}" in
  --static-self-test) static_self_test ;;
  --test-child)
    [ "${P3110_ATOMIC_TEST_MODE:-0}" = 1 ] || exit 2
    cleanup_armed=1
    trap finish EXIT
    "$2" "$PROTECTED_MARKER"
    ;;
  '') real_run ;;
  *) printf '%s\n' 'usage: run-headed-a1a.sh [--static-self-test]' >&2; exit 2 ;;
esac
