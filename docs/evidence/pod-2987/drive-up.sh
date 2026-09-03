#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/drive-env.sh"

LIVE_CREDENTIAL=/home/mgw/.claude/.credentials.json
LOGS="$PODIUM_DRIVE_BASE/logs"
AGENT_HOME="$PODIUM_RIG_STATE_ROOT/agent-home"
PROBE_REPO="$PODIUM_DRIVE_BASE/probes/claude-pty"
HEAD_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)"

mkdir -p "$LOGS" "$PODIUM_DRIVE_BASE/probes"
chmod 700 "$PODIUM_DRIVE_BASE"

if [ -e "$PODIUM_RIG_STATE_ROOT" ]; then
  echo "refusing reused state root: $PODIUM_RIG_STATE_ROOT" >&2
  exit 2
fi

bash "$HERE/../claim-instance.sh"
( cd "$PODIUM_DRIVE_REPO" && bun --conditions=@podium/source "$HERE/../state-root-check.ts" )

mkdir -p "$PROBE_REPO"
git -C "$PROBE_REPO" init -q -b main
printf '%s\n' 'Claude quota classification probe' > "$PROBE_REPO/README.md"
git -C "$PROBE_REPO" add README.md
git -C "$PROBE_REPO" -c user.email=drive@localhost -c user.name=drive \
  commit -qm 'quota probe seed'

mkdir -p "$AGENT_HOME/.claude"
chmod 700 "$AGENT_HOME" "$AGENT_HOME/.claude"

SOURCE_CREDENTIAL="$LIVE_CREDENTIAL" TARGET_CREDENTIAL="$AGENT_HOME/.claude/.credentials.json" bun -e '
  import { statSync } from "node:fs"
  const source = process.env.SOURCE_CREDENTIAL
  const target = process.env.TARGET_CREDENTIAL
  if (!source || !target) throw new Error("credential paths missing")
  const data = JSON.parse(await Bun.file(source).text())
  const expiresAt = data?.claudeAiOauth?.expiresAt
  if (typeof expiresAt !== "number" || expiresAt <= Date.now() + 600_000) {
    throw new Error("Claude access credential is expired or inside the ten-minute safety floor")
  }
  await Bun.write(target, await Bun.file(source).arrayBuffer())
  Bun.spawnSync(["chmod", "600", target])
  console.log(`credential metadata: mtime=${statSync(source).mtime.toISOString()} expiresAt=${expiresAt} valid=true`)
'

SOURCE_STATE=/home/mgw/.claude.json TARGET_STATE="$AGENT_HOME/.claude.json" PROBE_REPO="$PROBE_REPO" bun -e '
  const source = process.env.SOURCE_STATE
  const target = process.env.TARGET_STATE
  const repo = process.env.PROBE_REPO
  if (!source || !target || !repo) throw new Error("Claude state paths missing")
  const live = await Bun.file(source).exists() ? JSON.parse(await Bun.file(source).text()) : {}
  const state = {
    hasCompletedOnboarding: live.hasCompletedOnboarding === true,
    ...(typeof live.lastOnboardingVersion === "string" ? { lastOnboardingVersion: live.lastOnboardingVersion } : {}),
    projects: { [repo]: { hasTrustDialogAccepted: true } },
  }
  if (!state.hasCompletedOnboarding) throw new Error("live Claude state does not report completed onboarding")
  await Bun.write(target, JSON.stringify(state, null, 2) + "\n")
  Bun.spawnSync(["chmod", "600", target])
'

SETTINGS="$AGENT_HOME/.claude/settings.json"
SETTINGS_PATH="$SETTINGS" bun -e '
  const path = process.env.SETTINGS_PATH
  if (!path) throw new Error("settings path missing")
  await Bun.write(path, JSON.stringify({
    permissions: { defaultMode: "auto" },
    autoMode: { environment: ["### Quota probe", "- Classification only; do not use tools."] },
  }, null, 2) + "\n")
  Bun.spawnSync(["chmod", "600", path])
'

start() {
  local name="$1" script="$2"
  (
    cd "$PODIUM_DRIVE_REPO"
    nohup setsid env \
      PODIUM_INSTANCE="$PODIUM_INSTANCE" \
      PODIUM_PORT="$PODIUM_PORT" \
      PODIUM_HOOK_PORT="$PODIUM_HOOK_PORT" \
      PODIUM_AGENT_RELAY_PORT="$PODIUM_AGENT_RELAY_PORT" \
      PODIUM_PASSWORD="$PODIUM_PASSWORD" \
      PODIUM_NO_RELAY=1 \
      PODIUM_SPAWN_SHA="$HEAD_SHA" \
      PATH="$PATH" \
      bun --conditions=@podium/source "$script" \
      > "$LOGS/$name.log" 2>&1 < /dev/null &
    printf '%s\n' "$!" > "$PODIUM_DRIVE_BASE/$name.pid"
  )
  printf '%s\n' "$HEAD_SHA" > "$PODIUM_DRIVE_BASE/$name.sha"
  echo "started $name pid=$(<"$PODIUM_DRIVE_BASE/$name.pid") sha=$HEAD_SHA"
}

start server scripts/server.ts
for _ in $(seq 1 120); do
  curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null

start daemon scripts/daemon.ts
for _ in $(seq 1 120); do
  rg -q 'podium daemon up: connected to' "$LOGS/daemon.log" 2>/dev/null && break
  sleep 1
done
rg -q 'podium daemon up: connected to' "$LOGS/daemon.log"

echo "instance=$PODIUM_INSTANCE state=$PODIUM_RIG_STATE_ROOT agentHome=$AGENT_HOME port=$PODIUM_PORT"
