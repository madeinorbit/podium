#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/rig-env.sh"

action="${1:-}"
mkdir -p "$P3097_BASE/logs"
chmod 700 "$P3097_BASE"

alive() {
  local name="$1"
  local pidfile="$P3097_BASE/$name.pid"
  [ -f "$pidfile" ] && kill -0 "$(<"$pidfile")" 2>/dev/null
}

stop_pair() {
  local name pidfile pid
  for name in daemon server; do
    pidfile="$P3097_BASE/$name.pid"
    if [ -f "$pidfile" ]; then
      pid="$(<"$pidfile")"
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid"
        for _ in $(seq 1 40); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.25
        done
        kill -9 "$pid" 2>/dev/null || true
      fi
      rm -f "$pidfile"
    fi
  done
}

spawn_one() {
  local name="$1"
  local script="$2"
  local generation="$3"
  local log="$P3097_BASE/logs/${generation}-${name}.log"
  (
    cd "$P3097_REPO"
    nohup setsid env \
      PODIUM_INSTANCE="$P3097_INSTANCE" \
      PODIUM_STATE_DIR="$P3097_STATE_ROOT" \
      PODIUM_AGENT_HOME="$P3097_AGENT_HOME" \
      PODIUM_PORT="$P3097_PORT" \
      PODIUM_HOOK_PORT="$P3097_HOOK_PORT" \
      PODIUM_AGENT_RELAY_PORT="$P3097_RELAY_PORT" \
      PODIUM_PASSWORD="$P3097_PASSWORD" \
      PODIUM_WEB_DIR="$P3097_REPO/apps/web/dist" \
      PODIUM_RUNTIME_CONTRACT=1 \
      PODIUM_CHAT_STREAMING=1 \
      PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1 \
      PODIUM_NO_RELAY=1 \
      PODIUM_LOG_LEVEL=debug \
      PODIUM_SPAWN_SHA="$P3097_SHA" \
      PATH="$PATH" \
      bun --conditions=@podium/source "$script" >"$log" 2>&1 </dev/null &
    printf '%s\n' "$!" >"$P3097_BASE/$name.pid"
  )
  printf '%s\n' "$P3097_SHA" >"$P3097_BASE/$name.sha"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(date --iso-8601=seconds)" "$generation" "$name" \
    "$(<"$P3097_BASE/$name.pid")" "$P3097_SHA" >>"$P3097_BASE/spawns.tsv"
}

start_pair() {
  local generation
  generation="$(date -u +%Y%m%dT%H%M%SZ)"
  spawn_one server scripts/server.ts "$generation"
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$P3097_PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$P3097_PORT/health" >/dev/null
  spawn_one daemon scripts/daemon.ts "$generation"
  for _ in $(seq 1 120); do
    grep -q 'podium daemon up: connected to' "$P3097_BASE/logs/${generation}-daemon.log" 2>/dev/null && break
    sleep 1
  done
  grep -q 'podium daemon up: connected to' "$P3097_BASE/logs/${generation}-daemon.log"
  printf '%s\n' "$generation" >"$P3097_BASE/generation"
  printf '%s\n' "$(date --iso-8601=seconds)" >"$P3097_BASE/last-started-at"
}

seed_agent_home() {
  mkdir -p \
    "$P3097_AGENT_HOME/.codex" \
    "$P3097_AGENT_HOME/.claude" \
    "$P3097_AGENT_HOME/.grok" \
    "$P3097_AGENT_HOME/.local/share/opencode" \
    "$P3097_AGENT_HOME/.config/opencode"
  chmod 700 "$P3097_AGENT_HOME"

  link_if_present() {
    local source="$1"
    local target="$2"
    if [ -e "$source" ]; then
      ln -sfn "$source" "$target"
    fi
  }

  link_if_present "$HOME/.codex/auth.json" "$P3097_AGENT_HOME/.codex/auth.json"
  link_if_present "$HOME/.codex/config.toml" "$P3097_AGENT_HOME/.codex/config.toml"
  link_if_present "$HOME/.claude/.credentials.json" "$P3097_AGENT_HOME/.claude/.credentials.json"
  link_if_present "$HOME/.grok/auth.json" "$P3097_AGENT_HOME/.grok/auth.json"
  link_if_present "$HOME/.local/share/opencode/auth.json" "$P3097_AGENT_HOME/.local/share/opencode/auth.json"
  link_if_present "$HOME/.config/opencode/opencode.jsonc" "$P3097_AGENT_HOME/.config/opencode/opencode.jsonc"

  SOURCE_STATE="$HOME/.claude.json" TARGET_STATE="$P3097_AGENT_HOME/.claude.json" bun -e '
    const source = process.env.SOURCE_STATE
    const target = process.env.TARGET_STATE
    if (!source || !target) throw new Error("Claude state paths missing")
    const live = await Bun.file(source).exists() ? JSON.parse(await Bun.file(source).text()) : {}
    if (live.hasCompletedOnboarding !== true) throw new Error("Claude onboarding is not complete")
    const state = { hasCompletedOnboarding: true,
      ...(typeof live.lastOnboardingVersion === "string" ? { lastOnboardingVersion: live.lastOnboardingVersion } : {}) }
    await Bun.write(target, JSON.stringify(state, null, 2) + "\n")
  '
}

case "$action" in
  up)
    [ "$(git -C "$P3097_REPO" rev-parse HEAD)" = "$P3097_SHA" ]
    [ "$(git -C "$P3097_REPO" rev-parse refs/heads/issue/1761-agent-runtime)" = "$P3097_SHA" ]
    [ ! -e "$P3097_STATE_ROOT/instance.json" ] || {
      echo "refusing reused state root: $P3097_STATE_ROOT" >&2
      exit 2
    }
    [ "$(sed -n 's/.*\"sourceSha\": *\"\([^\"]*\)\".*/\1/p' "$P3097_REPO/apps/web/dist/podium-build.json")" = "${P3097_SHA:0:7}" ]
    mkdir -p "$P3097_STATE_ROOT"
    PODIUM_DRIVE_REPO="$P3097_REPO" bash "$P3097_REPO/docs/evidence/claim-instance.sh"
    seed_agent_home
    mkdir -p "$P3097_BASE/repo"
    if [ ! -d "$P3097_BASE/repo/.git" ]; then
      git -C "$P3097_BASE/repo" init -q -b main
      printf '%s\n' 'POD-3097 A11 provider probe' >"$P3097_BASE/repo/README.md"
      git -C "$P3097_BASE/repo" add README.md
      git -C "$P3097_BASE/repo" -c user.name=drive -c user.email=drive@localhost commit -qm 'probe seed'
    fi
    start_pair
    ;;
  restart)
    [ -f "$P3097_STATE_ROOT/instance.json" ]
    stop_pair
    start_pair
    ;;
  down)
    stop_pair
    ;;
  status)
    printf 'instance=%s state=%s agent_home=%s server=%s daemon=%s ports=%s,%s,%s generation=%s\n' \
      "$P3097_INSTANCE" "$P3097_STATE_ROOT" "$P3097_AGENT_HOME" \
      "$(alive server && echo live || echo dead)" "$(alive daemon && echo live || echo dead)" \
      "$P3097_PORT" "$P3097_HOOK_PORT" "$P3097_RELAY_PORT" \
      "$(<"$P3097_BASE/generation")"
    ;;
  *)
    echo "usage: $0 up|restart|down|status" >&2
    exit 2
    ;;
esac
