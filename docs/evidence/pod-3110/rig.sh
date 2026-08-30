#!/usr/bin/env bash
# POD-3110 — isolated Grok acceptance rig.
#
# This rig deliberately does not assign HOME, PODIUM_STATE_DIR, ABDUCO_SOCKET_DIR,
# PODIUM_RUNTIME_DRIVER, or any XDG path. PODIUM_PORT is exported only by the
# drive client; server and daemon use the complete product-derived port tuple. The named instance derives its state root,
# ports, and agent home from the product's normal resolvers.  The only paths
# supplied here are the checkout's built web bundle and the evidence scratch
# directory; neither changes instance identity.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
INSTANCE="p3110-grok-paired-057755c"
DRIVE_BASE="/tmp/pod-3110-grok-paired-057755c"
RUN_TOKEN="${P3110_RUN_TOKEN:?source rig-env.sh to set an immutable UTC run token}"
RUN_DIR="$DRIVE_BASE/runs/$RUN_TOKEN"
LOGS="$RUN_DIR/logs"
WEB="$REPO/apps/web/dist"
BUN="/home/mgw/.bun/bin/bun"
PASSWORD="p3110-grok-paired-057755c-proof"
NORMAL_HOME="${HOME:?HOME must be inherited from the operator environment}"

export PATH="/home/mgw/.bun/bin:/home/mgw/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

mkdir -p "$LOGS"

cleanup_on_failure() {
  local rc=$?
  [ "$rc" -eq 0 ] && return 0
  remove_isolated_credential >/dev/null 2>&1 || true
  stop_named daemon >/dev/null 2>&1 || true
  stop_named server >/dev/null 2>&1 || true
  printf '%s\n' "failure cleanup completed for run $RUN_TOKEN (rc=$rc)" >&2
}

validate_dependencies() {
  [ "$(sha256sum "$REPO/bun.lock" | awk '{print $1}')" = a1acc741d62d99b4146d5989a06a50ce494a9e93219b59e49af3ac4307430791 ] || { log "PREFLIGHT FAIL bun.lock hash" >&2; return 1; }
  [ -d "$REPO/node_modules" ] && [ ! -L "$REPO/node_modules" ] || { log "PREFLIGHT FAIL root node_modules must be a real checkout-local directory" >&2; return 1; }
  local link target
  for link in "$REPO/node_modules/@podium/runtime" "$REPO/node_modules/@podium/model"; do
    [ -e "$link" ] || { log "PREFLIGHT FAIL missing workspace link $link; run setup:worktree before launch" >&2; return 1; }
    target="$(readlink -f "$link")"
    case "$target" in "$REPO"/*) ;; *) log "PREFLIGHT FAIL workspace link escapes checkout: $link -> $target" >&2; return 1 ;; esac
  done
}

validate_immutable_inputs() {
  local want=057755c77a6bdfdf01aa526d968562b0316e78df short stamp version hash
  git -C "$REPO" merge-base --is-ancestor "$want" HEAD || { log "PREFLIGHT FAIL product pin is not an ancestor" >&2; return 1; }
  git -C "$REPO" diff --quiet "$want" HEAD -- . ':(exclude)docs/**' || { log "PREFLIGHT FAIL product bytes differ from exact pin" >&2; return 1; }
  [ -f "$WEB/podium-build.json" ] || { log "PREFLIGHT FAIL web bundle missing" >&2; return 1; }
  short="${want:0:7}"
  stamp="$(sed -n 's/.*"sourceSha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WEB/podium-build.json")"
  [ "$stamp" = "$short" ] || { log "PREFLIGHT FAIL web sourceSha=$stamp want=$short" >&2; return 1; }
  hash="$(sha256sum /home/mgw/.grok/downloads/grok-linux-x86_64 | awk '{print $1}')"
  [ "$hash" = c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6 ] || { log "PREFLIGHT FAIL Grok hash" >&2; return 1; }
  version="$(/home/mgw/.grok/downloads/grok-linux-x86_64 --version 2>&1 | head -1 | tr -d '\r')"
  [ "$version" = '0.2.118 (1e1687c1cf) [stable]' ] || { log "PREFLIGHT FAIL Grok version=$version" >&2; return 1; }
  local isolated_auth="$AGENT_HOME/.grok/auth.json" operator_auth="$NORMAL_HOME/.grok/auth.json"
  if [ -L "$isolated_auth" ]; then
    [ "$(readlink -f "$isolated_auth")" = "$(readlink -f "$operator_auth")" ] || { log "PREFLIGHT FAIL credential symlink target" >&2; return 1; }
  elif [ -e "$isolated_auth" ]; then
    log "PREFLIGHT FAIL isolated credential is not a symlink" >&2; return 1
  fi
  validate_dependencies
}

# The Podium session itself has relay and default-instance variables in its
# environment.  A child runtime inheriting them would silently join the
# operator instance.  These are scrubbed, while HOME is intentionally inherited.
unset_names=(
  ABDUCO_SESSION ABDUCO_SOCKET ABDUCO_SOCKET_DIR
  PODIUM_AGENT_RELAY PODIUM_AGENT_RELAY_PORT PODIUM_AGENT_HOME
  PODIUM_APP_VERSION PODIUM_CODEX_HOOK_SOCKET PODIUM_CODEX_HOOK_URL
  PODIUM_HOME PODIUM_HOOK_PORT PODIUM_HOST PODIUM_MOBILE_WEB_DIR PODIUM_PASSWORD
  PODIUM_PORT PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY
  PODIUM_STATE_DIR PODIUM_WEB_DIR PODIUM_RUNTIME_DRIVER
  XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME GROK_HOME
)

env_args=()
for name in "${unset_names[@]}"; do env_args+=( -u "$name" ); done

state_dir() {
  env "${env_args[@]}" \
    PODIUM_INSTANCE="$INSTANCE" PODIUM_NO_RELAY=1 \
    "$BUN" --conditions=@podium/source -e \
    'import { instanceStateDir } from "@podium/runtime/instance"; console.log(instanceStateDir())'
}

ports() {
  env "${env_args[@]}" \
    PODIUM_INSTANCE="$INSTANCE" PODIUM_NO_RELAY=1 \
    "$BUN" --conditions=@podium/source -e \
    'import { defaultInstancePorts } from "@podium/runtime/instance"; const p=defaultInstancePorts(process.env.PODIUM_INSTANCE); console.log(`${p.server} ${p.hook} ${p.agentRelay}`)'
}

STATE_DIR="$(state_dir)"
read -r PORT HOOK_PORT RELAY_PORT <<<"$(ports)"
for derived in "$PORT" "$HOOK_PORT" "$RELAY_PORT"; do
  case "$derived" in 19797|32090) printf '%s\n' "refusing reserved port $derived" >&2; exit 1 ;; esac
done
[ "$PORT" != "$HOOK_PORT" ] && [ "$PORT" != "$RELAY_PORT" ] && [ "$HOOK_PORT" != "$RELAY_PORT" ] || { printf '%s\n' 'refusing duplicate derived ports' >&2; exit 1; }
AGENT_HOME="$STATE_DIR/agent-home"

runtime_env=(
  "${env_args[@]}"
  PODIUM_INSTANCE="$INSTANCE"
  PODIUM_NO_RELAY=1
  PODIUM_WEB_DIR="$WEB"
  PODIUM_PASSWORD="$PASSWORD"
  PATH="$PATH"
)

daemon_env=(
  "${runtime_env[@]}"
  PODIUM_RUNTIME_CONTRACT=1
)

log() { printf '%s\n' "$*"; }

pid_of() {
  local name="$1"
  local file="$RUN_DIR/$name.pid"
  [ -s "$file" ] || return 1
  cat "$file"
}

stop_named() {
  local name="$1"
  local file="$RUN_DIR/$name.pid"
  [ -s "$file" ] || return 0
  local pid
  pid="$(cat "$file")"
  if kill -0 "$pid" 2>/dev/null; then
    [ "$(readlink -f "/proc/$pid/cwd")" = "$REPO" ] || { log "REFUSED stop $name pid=$pid: cwd mismatch" >&2; return 1; }
    tr '\0' '\n' <"/proc/$pid/environ" | grep -Fx "PODIUM_INSTANCE=$INSTANCE" >/dev/null || { log "REFUSED stop $name pid=$pid: instance mismatch" >&2; return 1; }
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 80); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    log "stopped $name pid=$pid"
  fi
  rm -f "$file"
}

start_component() {
  local name="$1"
  local script="$2"
  shift 2
  local -a extra=( "$@" )
  local -a env_for_component=( "${runtime_env[@]}" )
  if [ "$name" = daemon ]; then
    env_for_component=( "${daemon_env[@]}" )
  fi
  if [ "${#extra[@]}" -gt 0 ]; then env_for_component+=( "${extra[@]}" ); fi

  # Keep the actual Bun process alive after this launcher exits. The shell that
  # invokes the rig may be reaped by the acceptance harness, so a bare
  # background subshell is not a detached runtime.
  nohup bash -c 'cd "$1"; shift; exec "$@"' _ "$REPO" env "${env_for_component[@]}" "$BUN" --conditions=@podium/source "$script" \
    >"$LOGS/$name.log" 2>&1 </dev/null &
  local pid=$!
  printf '%s\n' "$pid" >"$RUN_DIR/$name.pid"
  # This is the pin: record the checkout SHA at the same moment the process is
  # spawned.  Never infer it from /proc mtimes.
  printf '%s\n' 057755c77a6bdfdf01aa526d968562b0316e78df >"$RUN_DIR/$name.sha"
  git -C "$REPO" rev-parse HEAD >"$RUN_DIR/$name.harness-sha"
  log "started $name pid=$pid at $(cut -c1-7 "$RUN_DIR/$name.sha")"
}

wait_health() {
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  log "server never served /health; see $LOGS/server.log" >&2
  return 1
}

claim_state() {
  env "${env_args[@]}" \
    PODIUM_INSTANCE="$INSTANCE" PODIUM_NO_RELAY=1 \
    "$BUN" --conditions=@podium/source -e \
    'import { loadConfig, saveConfig } from "@podium/runtime/config"; saveConfig({ ...loadConfig(), mode: "all-in-one" })'
}

seed_grok() {
  mkdir -p "$AGENT_HOME/.grok"
  chmod 700 "$AGENT_HOME" "$AGENT_HOME/.grok"
  if [ ! -f "$AGENT_HOME/.grok/auth.json" ]; then
    if [ ! -f "$NORMAL_HOME/.grok/auth.json" ]; then
      log "no normal-home Grok credential; leaving the derived agent home logged out for A8/login-path evidence"
      return 0
    fi
    ln -s "$NORMAL_HOME/.grok/auth.json" "$AGENT_HOME/.grok/auth.json"
    chmod 600 "$NORMAL_HOME/.grok/auth.json"
  fi
}
remove_isolated_credential() {
  local live="$AGENT_HOME/.grok/auth.json" saved="$AGENT_HOME/.grok/auth.json.acceptance-saved"
  [ ! -L "$live" ] || rm -f -- "$live"
  [ ! -L "$saved" ] || rm -f -- "$saved"
}


up() {
  local arm="${1:-headless}"
  case "$arm" in headless|terminal) ;; *) log "usage: $0 up headless|terminal" >&2; return 2 ;; esac
  stop_named daemon
  stop_named server
  if [ ! -f "$RUN_DIR/state-owned" ] && [ -e "$STATE_DIR/instance.json" ]; then
    log "PREFLIGHT FAIL named instance marker already exists; refusing non-fresh drive" >&2
    return 1
  fi
  validate_immutable_inputs

  trap cleanup_on_failure EXIT
  claim_state
  : >"$RUN_DIR/state-owned"
  seed_grok
  rm -f "$RUN_DIR/daemon.sha" "$RUN_DIR/server.sha"

  start_component server scripts/server.ts PODIUM_CHAT_STREAMING=1
  wait_health
  start_component daemon scripts/daemon.ts
  for _ in $(seq 1 90); do
    kill -0 "$(pid_of daemon)" 2>/dev/null && break
    sleep 1
  done
  log "instance=$INSTANCE arm=$arm port=$PORT state=$STATE_DIR"
  log "home=$NORMAL_HOME (inherited; not overridden)"
  log "web=$WEB"
  log "logs=$LOGS"
}

restart_daemon() {
  local arm="${1:-headless}"
  stop_named daemon
  start_component daemon scripts/daemon.ts
  sleep 2
  kill -0 "$(pid_of daemon)" 2>/dev/null
  log "daemon restarted for arm=$arm pid=$(pid_of daemon)"
}

proc_env() {
  tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null || true
}

check_memory() {
  local kb
  kb="$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo)"
  local mb=$((kb / 1024))
  log "MEMAVAILABLE_MB=$mb"
  [ "$mb" -ge 1200 ]
}

verify() {
  local arm="${1:?verify arm row}"
  local row="${2:?verify arm row}"
  local want_sha want_short stamp web_sha server_pid daemon_pid
  want_sha=057755c77a6bdfdf01aa526d968562b0316e78df
  git -C "$REPO" merge-base --is-ancestor "$want_sha" HEAD || { log "PIN FAIL ancestry"; return 1; }
  git -C "$REPO" diff --quiet "$want_sha" HEAD -- . ':(exclude)docs/**' || { log "PIN FAIL product bytes"; return 1; }
  [ "$(sha256sum /home/mgw/.grok/downloads/grok-linux-x86_64 | awk '{print $1}')" = c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6 ] || { log "PIN FAIL grok binary"; return 1; }
  want_short="${want_sha:0:7}"
  server_pid="$(pid_of server)"
  daemon_pid="$(pid_of daemon)"
  kill -0 "$server_pid" 2>/dev/null || { log "PIN FAIL server pid=$server_pid is not alive"; return 1; }
  kill -0 "$daemon_pid" 2>/dev/null || { log "PIN FAIL daemon pid=$daemon_pid is not alive"; return 1; }
  [ "$(readlink -f "/proc/$server_pid/cwd")" = "$REPO" ] || { log "PIN FAIL server cwd"; return 1; }
  [ "$(readlink -f "/proc/$daemon_pid/cwd")" = "$REPO" ] || { log "PIN FAIL daemon cwd"; return 1; }
  [ "$(cat "$RUN_DIR/server.sha")" = "$want_sha" ] || { log "PIN FAIL server spawn SHA"; return 1; }
  [ "$(cat "$RUN_DIR/daemon.sha")" = "$want_sha" ] || { log "PIN FAIL daemon spawn SHA"; return 1; }
  git -C "$REPO" merge-base --is-ancestor "$(cat "$RUN_DIR/server.harness-sha")" HEAD || { log "PIN FAIL server harness ancestry"; return 1; }
  git -C "$REPO" merge-base --is-ancestor "$(cat "$RUN_DIR/daemon.harness-sha")" HEAD || { log "PIN FAIL daemon harness ancestry"; return 1; }
  git -C "$REPO" diff --quiet "$(cat "$RUN_DIR/server.harness-sha")" HEAD -- . ':(exclude)docs/**' || { log "PIN FAIL post-spawn product drift"; return 1; }

  stamp="$(curl -fsS "http://127.0.0.1:$PORT/podium-build.json")"
  web_sha="$(printf '%s' "$stamp" | sed -n 's/.*"sourceSha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ "$web_sha" = "$want_short" ] || { log "PIN FAIL served web sourceSha=$web_sha want=$want_short"; return 1; }

  local server_env daemon_env_text
  server_env="$(proc_env "$server_pid")"
  daemon_env_text="$(proc_env "$daemon_pid")"
  printf '%s\n' "$server_env" | grep -Fx "PODIUM_INSTANCE=$INSTANCE" >/dev/null || { log "PIN FAIL server instance"; return 1; }
  printf '%s\n' "$daemon_env_text" | grep -Fx "PODIUM_INSTANCE=$INSTANCE" >/dev/null || { log "PIN FAIL daemon instance"; return 1; }
  for bad in PODIUM_STATE_DIR ABDUCO_SOCKET_DIR ABDUCO_SOCKET PODIUM_AGENT_HOME PODIUM_HOME; do
    printf '%s\n' "$server_env" | grep -E "^$bad=" >/dev/null && { log "PIN FAIL server has forbidden $bad"; return 1; } || true
    printf '%s\n' "$daemon_env_text" | grep -E "^$bad=" >/dev/null && { log "PIN FAIL daemon has forbidden $bad"; return 1; } || true
  done
  printf '%s\n' "$server_env" | grep -Fx "HOME=$NORMAL_HOME" >/dev/null || { log "PIN FAIL server HOME"; return 1; }
  printf '%s\n' "$daemon_env_text" | grep -Fx "HOME=$NORMAL_HOME" >/dev/null || { log "PIN FAIL daemon HOME"; return 1; }
  local actual_driver
  actual_driver="$(printf '%s\n' "$daemon_env_text" | sed -n 's/^PODIUM_RUNTIME_DRIVER=//p' | tail -1)"
  [ -z "$actual_driver" ] || { log "PIN FAIL runtime override=$actual_driver"; return 1; }
  log "PIN OK row=$row arm=$arm instance=$INSTANCE serverPid=$server_pid daemonPid=$daemon_pid serverSha=$want_sha webSourceSha=$web_sha driver=no-runtime-override grokBinSha256=c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6 state=$STATE_DIR home=$NORMAL_HOME"
  log "PIN FLAGS no-PODIUM_STATE_DIR no-ABDUCO_SOCKET_DIR inherited-HOME"
}

auth() {
  local action="${1:?auth off|on}"
  local live="$AGENT_HOME/.grok/auth.json"
  local saved="$AGENT_HOME/.grok/auth.json.acceptance-saved"
  case "$action" in
    off)
      [ -f "$live" ] || { log "Grok auth already absent"; return 0; }
      mv "$live" "$saved"
      log "Grok auth moved aside at $saved (recoverable)"
      ;;
    on)
      [ -f "$saved" ] && mv "$saved" "$live"
      [ -f "$live" ] || seed_grok
      if [ -f "$live" ]; then
        chmod 600 "$live"
        log "Grok auth restored at $live"
      else
        log "Grok auth remains absent at $live; no credential was available to restore"
      fi
      ;;
    *) log "usage: $0 auth off|on" >&2; return 2 ;;
  esac
}

down() {
  stop_named daemon
  stop_named server
  remove_isolated_credential
  log "instance=$INSTANCE stopped; derived state retained at $STATE_DIR for evidence/recovery"
}

case "${1:-}" in
  up) up "${2:-headless}" ;;
  restart-daemon) restart_daemon "${2:-headless}" ;;
  verify) verify "${2:-}" "${3:-}" ;;
  check-memory) check_memory ;;
  auth) auth "${2:-}" ;;
  down) down ;;
  info) log "instance=$INSTANCE port=$PORT state=$STATE_DIR agentHome=$AGENT_HOME web=$WEB home=$NORMAL_HOME" ;;
  *)
    log "usage: $0 up headless|terminal | restart-daemon headless|terminal | verify ARM ROW | check-memory | auth off|on | down | info" >&2
    exit 2
    ;;
esac
