#!/usr/bin/env bash
# Named-instance bring-up for POD-3028. Static and runtime admission only.
# Does not copy, refresh, or rotate Claude credentials. Uses the live operator
# credential in $HOME via the product's account-home selection.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/drive-env.sh"

LIVE_CREDENTIAL=/home/mgw/.claude/.credentials.json
LOGS="$PODIUM_DRIVE_BASE/logs"
PTY_CWD="$PODIUM_DRIVE_BASE/probes/claude-pty"
SDK_CWD="$PODIUM_DRIVE_BASE/probes/claude-sdk"
HEAD_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)"
FLOOR_BYTES=$((5 * 1024 * 1024 * 1024))

mkdir -p "$LOGS" "$PODIUM_DRIVE_BASE/probes"
chmod 700 "$PODIUM_DRIVE_BASE"

avail="$(df -B1 / | awk 'NR==2 {print $4}')"
if [ "$avail" -lt "$FLOOR_BYTES" ]; then
  echo "refusing launch: disk ${avail} bytes is below the 5 GiB runtime floor" >&2
  exit 3
fi

if [ ! -d "$PODIUM_DRIVE_REPO/node_modules/@podium" ]; then
  echo "refusing launch: $PODIUM_DRIVE_REPO has no node_modules/@podium links" >&2
  exit 4
fi

if [ -e "$PODIUM_RIG_STATE_ROOT" ]; then
  echo "refusing reused state root: $PODIUM_RIG_STATE_ROOT" >&2
  exit 2
fi

if [ ! -f "$LIVE_CREDENTIAL" ]; then
  echo "refusing launch: live Claude credential is missing" >&2
  exit 5
fi

export SOURCE_CREDENTIAL="$LIVE_CREDENTIAL"
bun -e '
  import { statSync } from "node:fs"
  const source = process.env.SOURCE_CREDENTIAL
  if (!source) throw new Error("credential path missing")
  const data = JSON.parse(await Bun.file(source).text())
  const expiresAt = data?.claudeAiOauth?.expiresAt
  const now = Date.now()
  if (typeof expiresAt !== "number" || expiresAt <= now) {
    throw new Error("Claude access credential is expired; refusing launch to avoid OAuth refresh")
  }
  if (expiresAt <= now + 600_000) {
    throw new Error("Claude access credential is inside the ten-minute safety floor; refusing launch")
  }
  const st = statSync(source)
  console.log(`credential metadata: mtime=${st.mtime.toISOString()} expiresAt=${new Date(expiresAt).toISOString()} valid=true`)
'

# Prove we will not seed an isolated copy. The product must use $HOME.
if [ -e "$PODIUM_RIG_STATE_ROOT/agent-home/.claude/.credentials.json" ]; then
  echo "refusing launch: isolated credential copy already exists" >&2
  exit 6
fi

bash "$HERE/../claim-instance.sh"
( cd "$PODIUM_DRIVE_REPO" && bun --conditions=@podium/source "$HERE/../state-root-check.ts" )

seed_probe() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  printf '%s\n' 'Claude quota reset probe' > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" -c user.email=drive@localhost -c user.name=drive \
    commit -qm 'quota probe seed'
}
seed_probe "$PTY_CWD"
seed_probe "$SDK_CWD"

start() {
  local name="$1" script="$2"
  shift 2
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
      "$@" \
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

# TOS gate makes claude-sdk available. It does not select it as the default.
# The confirming PTY spawn omits runtimeContract and must stay on claude-pty.
start daemon scripts/daemon.ts PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1
for _ in $(seq 1 120); do
  grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" 2>/dev/null && break
  sleep 1
done
grep -q 'podium daemon up: connected to' "$LOGS/daemon.log"

printf '%s\n' "$HEAD_SHA" > "$PODIUM_DRIVE_BASE/head.sha"
echo "instance=$PODIUM_INSTANCE state=$PODIUM_RIG_STATE_ROOT port=$PODIUM_PORT tos=daemon-only"
echo "liveCredential=$LIVE_CREDENTIAL (not copied)"
echo "isolatedCopyAbsent=$([ ! -e "$PODIUM_RIG_STATE_ROOT/agent-home/.claude/.credentials.json" ] && echo yes || echo no)"
