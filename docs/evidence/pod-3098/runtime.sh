#!/usr/bin/env bash
# POD-3098 exact-tip A3 runtime. This is intentionally one named, explicit,
# non-default instance; it never resolves or reads the operator default state.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
BASE=/tmp/pod-3098-a3-b605f2a
STATE_ROOT="$BASE/state"
AGENT_HOME="$BASE/agent-home"
SCRATCH="$BASE/provider-work"
LOGS="$BASE/logs"
INSTANCE=p3098-a3-current-tip
PORT=19983
HOOK_PORT=46983
RELAY_PORT=46984
PASSWORD=p3098-a3
BASE_PIN=60dd85b2e721a30d4f7a74717b00ce0f8d39d9eb
PIN=b605f2a6becbadc0b801c103194f7526258b96bb
BUN=/home/mgw/.bun/bin/bun
XDG_RUN=/run/user/1001
DBUS_ADDR=unix:path=/run/user/1001/bus
INSTALLED_PODIUM=/home/mgw/.local/bin/podium
RUNTIME_PATH=/tmp/pod-2777/bin:/home/mgw/.local/bin:/home/mgw/.opencode/bin:/home/mgw/.bun/bin:/usr/local/bin:/usr/bin:/bin

fail() { echo "POD-3098 RUNTIME REFUSED: $*" >&2; exit 2; }

assert_source() {
  git -C "$ROOT" merge-base --is-ancestor "$PIN" HEAD || fail "evidence branch no longer descends from $PIN"
  git -C "$ROOT" diff --quiet "$PIN" HEAD -- . ":!docs" || fail "product source differs from exact pin $PIN"
  [ "$(git -C "$ROOT" rev-parse refs/heads/issue/1761-agent-runtime)" = "$BASE_PIN" ] \
    || fail "issue/1761-agent-runtime moved from $BASE_PIN"
  local dirty
  dirty="$(git -C "$ROOT" status --porcelain | sed '/^.. docs\/evidence\/pod-3098\//d')"
  [ -z "$dirty" ] || fail "product tree is dirty outside this evidence directory: $dirty"
  [ -x "$INSTALLED_PODIUM" ] || fail "installed Podium CLI/relay is unavailable; wait instead of substituting source CLI"
  [ -n "${PODIUM_SESSION_RELAY:-}" ] || fail "installed session relay is unavailable; wait instead of using a source CLI"
  [ "$PORT" != 19797 ] || fail "port 19797 is forbidden"
  [ "$PORT" != 32090 ] || fail "port 32090 is forbidden"
}

common_env() {
  env -i \
    HOME=/home/mgw USER=mgw LANG=C.UTF-8 TERM=xterm-256color \
    XDG_RUNTIME_DIR="$XDG_RUN" DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" \
    PATH="$RUNTIME_PATH" \
    PODIUM_INSTANCE="$INSTANCE" \
    PODIUM_STATE_DIR="$STATE_ROOT" \
    PODIUM_AGENT_HOME="$AGENT_HOME" \
    PODIUM_PORT="$PORT" \
    PODIUM_HOOK_PORT="$HOOK_PORT" \
    PODIUM_AGENT_RELAY_PORT="$RELAY_PORT" \
    PODIUM_PASSWORD="$PASSWORD" \
    PODIUM_NO_RELAY=1 \
    PODIUM_SPAWN_SHA="$PIN" \
    PODIUM_WEB_DIR="$ROOT/apps/web/dist" \
    PODIUM_CHAT_STREAMING=1 \
    PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1 \
    PODIUM_LOG_LEVEL=debug \
    "$@"
}

init_runtime() {
  assert_source
  [ ! -e "$STATE_ROOT/instance.json" ] || fail "state root already exists; this drive requires a fresh isolated state"
  mkdir -p "$BASE" "$LOGS" "$AGENT_HOME/.claude" "$AGENT_HOME/.codex" \
    "$AGENT_HOME/.grok" "$AGENT_HOME/.local/share/opencode" "$AGENT_HOME/.config/opencode" "$SCRATCH"
  chmod 700 "$BASE" "$STATE_ROOT" "$AGENT_HOME" 2>/dev/null || true

  common_env "$BUN" --conditions=@podium/source -e '
    import { loadConfig, saveConfig } from "./packages/runtime/src/config.ts"
    saveConfig({ ...loadConfig(), mode: "all-in-one", agentHome: process.env.PODIUM_AGENT_HOME })
  ' --cwd "$ROOT"

  for pair in \
    "/home/mgw/.codex/auth.json:$AGENT_HOME/.codex/auth.json" \
    "/home/mgw/.codex/config.toml:$AGENT_HOME/.codex/config.toml" \
    "/home/mgw/.grok/auth.json:$AGENT_HOME/.grok/auth.json" \
    "/home/mgw/.local/share/opencode/auth.json:$AGENT_HOME/.local/share/opencode/auth.json" \
    "/home/mgw/.config/opencode/opencode.jsonc:$AGENT_HOME/.config/opencode/opencode.jsonc"
  do
    from="${pair%%:*}"; to="${pair#*:}"
    if [ -f "$from" ]; then cp "$from" "$to"; chmod 600 "$to"; fi
  done
  [ -f /home/mgw/.claude/.credentials.json ] || fail "Claude credential absent; real SDK arm unavailable"
  ln -s /home/mgw/.claude/.credentials.json "$AGENT_HOME/.claude/.credentials.json"
  if [ -f /home/mgw/.claude.json ]; then cp /home/mgw/.claude.json "$AGENT_HOME/.claude.json"; chmod 600 "$AGENT_HOME/.claude.json"; fi

  if [ ! -d "$SCRATCH/.git" ]; then
    git -C "$SCRATCH" init -q -b main
    printf '%s\n' 'POD-3098 provider-turn scratch repository' > "$SCRATCH/README.md"
    git -C "$SCRATCH" add README.md
    git -C "$SCRATCH" -c user.name=drive -c user.email=drive@localhost commit -qm 'provider turn seed'
  fi
  echo "initialized instance=$INSTANCE state=$STATE_ROOT agentHome=$AGENT_HOME ports=$PORT/$HOOK_PORT/$RELAY_PORT"
}

stop_pair() {
  for name in daemon server; do
    pidfile="$BASE/$name.pid"
    [ -f "$pidfile" ] || continue
    pid="$(sed -n '1p' "$pidfile")"
    case "$pid" in ''|*[!0-9]*) fail "unsafe $name pid '$pid'";; esac
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done
}

start_one() {
  local name="$1" script="$2" contract="$3" driver="$4"
  local log="$LOGS/$name.log"
  local -a arm=(PODIUM_RUNTIME_CONTRACT="$contract")
  [ -z "$driver" ] || arm+=(PODIUM_RUNTIME_DRIVER="$driver")
  (
    cd "$ROOT"
    nohup setsid "$(type -P env)" -i \
      HOME=/home/mgw USER=mgw LANG=C.UTF-8 TERM=xterm-256color \
      XDG_RUNTIME_DIR="$XDG_RUN" DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR" \
      PATH="$RUNTIME_PATH" \
      PODIUM_INSTANCE="$INSTANCE" PODIUM_STATE_DIR="$STATE_ROOT" PODIUM_AGENT_HOME="$AGENT_HOME" \
      PODIUM_PORT="$PORT" PODIUM_HOOK_PORT="$HOOK_PORT" PODIUM_AGENT_RELAY_PORT="$RELAY_PORT" \
      PODIUM_PASSWORD="$PASSWORD" PODIUM_NO_RELAY=1 PODIUM_SPAWN_SHA="$PIN" \
      PODIUM_WEB_DIR="$ROOT/apps/web/dist" PODIUM_CHAT_STREAMING=1 \
      PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1 PODIUM_LOG_LEVEL=debug \
      "${arm[@]}" \
      "$BUN" --conditions=@podium/source "$script" >"$log" 2>&1 < /dev/null &
    printf '%s\n' "$!" > "$BASE/$name.pid"
  )
  printf '%s\n' "$PIN" > "$BASE/$name.sha"
}

arm_values() {
  case "${1:-headless}" in
    headless) printf '%s\n%s\n' 1 '' ;;
    terminal) printf '%s\n%s\n' 1 generic-pty ;;
    claude-terminal) printf '%s\n%s\n' claude-pty '' ;;
    *) fail "unknown runtime arm '$1'" ;;
  esac
}

start_pair() {
  assert_source
  [ -f "$STATE_ROOT/instance.json" ] || fail "run init first"
  mapfile -t values < <(arm_values "${1:-headless}")
  contract="${values[0]}"; driver="${values[1]}"
  stop_pair
  start_one server scripts/server.ts "$contract" "$driver"
  for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || fail "server did not become healthy"
  start_one daemon scripts/daemon.ts "$contract" "$driver"
  for _ in $(seq 1 120); do grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" 2>/dev/null && break; sleep 1; done
  grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" || fail "daemon did not connect"
  verify_runtime "${1:-headless}"
}

env_value() {
  local pid="$1" key="$2"
  tr '\0' '\n' < "/proc/$pid/environ" | sed -n "s/^$key=//p" | tail -1
}

verify_runtime() {
  local arm="${1:-headless}"
  assert_source
  mapfile -t values < <(arm_values "$arm")
  local contract="${values[0]}" driver="${values[1]}"
  for name in server daemon; do
    pid="$(sed -n '1p' "$BASE/$name.pid")"
    kill -0 "$pid" 2>/dev/null || fail "$name pid $pid is not alive"
    [ "$(readlink -f "/proc/$pid/cwd")" = "$ROOT" ] || fail "$name cwd mismatch"
    [ "$(sed -n '1p' "$BASE/$name.sha")" = "$PIN" ] || fail "$name spawn pin mismatch"
    [ "$(env_value "$pid" PODIUM_INSTANCE)" = "$INSTANCE" ] || fail "$name instance mismatch"
    [ "$(env_value "$pid" PODIUM_STATE_DIR)" = "$STATE_ROOT" ] || fail "$name state-root mismatch"
    [ "$(env_value "$pid" PODIUM_AGENT_HOME)" = "$AGENT_HOME" ] || fail "$name agent-home mismatch"
    [ "$(env_value "$pid" PODIUM_PORT)" = "$PORT" ] || fail "$name port mismatch"
  done
  daemon_pid="$(sed -n '1p' "$BASE/daemon.pid")"
  [ "$(env_value "$daemon_pid" PODIUM_RUNTIME_CONTRACT)" = "$contract" ] || fail "contract arm mismatch"
  [ "$(env_value "$daemon_pid" PODIUM_RUNTIME_DRIVER)" = "$driver" ] || fail "driver arm mismatch"
  stamp="$(curl -fsS "http://127.0.0.1:$PORT/podium-build.json")"
  printf '%s' "$stamp" | grep -Eq '"sourceSha"[[:space:]]*:[[:space:]]*"b605f2a"' || fail "served web pin is not b605f2a: $stamp"
  echo "PIN VERIFIED head=$PIN server=$(sed -n '1p' "$BASE/server.sha") daemon=$(sed -n '1p' "$BASE/daemon.sha") web=b605f2a arm=$arm instance=$INSTANCE state=$STATE_ROOT agentHome=$AGENT_HOME ports=$PORT/$HOOK_PORT/$RELAY_PORT"
}

case "${1:-}" in
  init) init_runtime ;;
  start) start_pair "${2:-headless}" ;;
  restart) start_pair "${2:-headless}" ;;
  verify) verify_runtime "${2:-headless}" ;;
  stop) stop_pair ;;
  *) fail "usage: runtime.sh init|start|restart|verify|stop [headless|terminal|claude-terminal]" ;;
esac
