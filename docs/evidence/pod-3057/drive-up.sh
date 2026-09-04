#!/usr/bin/env bash
# Bring up the POD-3057 rig: server + daemon on a named instance, nothing else.
#
# No web bundle is served or certified — every measurement here goes through
# tRPC, and a bundle stamped with someone else's commit is the one certificate
# worth refusing (POD-746).
#
# THE AGENT HOME IS LOGGED IN, deliberately, and by SYMLINK rather than copy.
# The whole subject of this issue is which home the SDK child runs in; with the
# fix it runs in the instance's agent home, and a credential-free home there is
# genuinely logged out, so the cell could not be driven at all. The symlink
# points at the operator credential the PRE-FIX child was already using — the
# arms therefore differ in the home, not in the account, and the rig adds no
# exposure that the behaviour under test did not already have.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
HEAD_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)"
git -C "$PODIUM_DRIVE_REPO" diff --quiet HEAD -- . ':!docs' \
  || { echo "refusing: product tree is dirty against HEAD $HEAD_SHA" >&2; exit 2; }
mkdir -p "$LOGS"
chmod 700 "$PODIUM_DRIVE_BASE"

# Capacity floor: 5 GiB root free, 1.5 GiB MemAvailable.
python3 - <<'PY'
import os
st = os.statvfs('/')
free = st.f_bavail * st.f_frsize
mem = 0
for line in open('/proc/meminfo'):
    if line.startswith('MemAvailable:'):
        mem = int(line.split()[1]) * 1024
        break
print(f'capacity root_free_bytes={free} mem_available_bytes={mem}')
if free < 5 * 1024**3:
    raise SystemExit('refusing: root free below 5 GiB floor')
if mem < int(1.5 * 1024**3):
    raise SystemExit('refusing: MemAvailable below 1.5 GiB')
PY

bash "$PODIUM_DRIVE_REPO/docs/evidence/pod-2777/link-node-modules.sh" >/dev/null

# The instance claims its own state root first, through the product's own
# config writer: a rig that creates directories under it beforehand is refused
# adoption of a root it made non-empty itself.
bash "$PODIUM_DRIVE_REPO/docs/evidence/claim-instance.sh"
( cd "$PODIUM_DRIVE_REPO" && bun --conditions=@podium/source "$PODIUM_DRIVE_REPO/docs/evidence/state-root-check.ts" )

AGENT_HOME="$PODIUM_RIG_STATE_ROOT/agent-home"
mkdir -p "$AGENT_HOME/.claude" "$PODIUM_DRIVE_BASE/probes"
chmod 700 "$AGENT_HOME" "$AGENT_HOME/.claude"
[ -f "$HOME/.claude/.credentials.json" ] || { echo "operator is not logged in to claude" >&2; exit 2; }
ln -sfn "$HOME/.claude/.credentials.json" "$AGENT_HOME/.claude/.credentials.json"
SOURCE_STATE="$HOME/.claude.json" TARGET_STATE="$AGENT_HOME/.claude.json" bun -e '
  const source = process.env.SOURCE_STATE
  const target = process.env.TARGET_STATE
  const live = await Bun.file(source).exists() ? JSON.parse(await Bun.file(source).text()) : {}
  const state = {
    hasCompletedOnboarding: live.hasCompletedOnboarding === true,
    ...(typeof live.lastOnboardingVersion === "string" ? { lastOnboardingVersion: live.lastOnboardingVersion } : {}),
    ...(live.oauthAccount ? { oauthAccount: live.oauthAccount } : {}),
  }
  if (!state.hasCompletedOnboarding) throw new Error("live Claude state does not report completed onboarding")
  await Bun.write(target, JSON.stringify(state, null, 2) + "\n")
  Bun.spawnSync(["chmod", "600", target])
  console.log("seeded onboarding/account state; credential is a symlink to the operator file")
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
      PODIUM_RUNTIME_CONTRACT="$PODIUM_RUNTIME_CONTRACT" \
      PODIUM_CHAT_STREAMING="$PODIUM_CHAT_STREAMING" \
      PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1 \
      PODIUM_LOG_LEVEL=debug \
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
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null \
  || { echo "server never served /health"; tail -40 "$LOGS/server.log"; exit 1; }
echo "server healthy on :$PODIUM_PORT"

start daemon scripts/daemon.ts
for _ in $(seq 1 120); do
  grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" 2>/dev/null && break
  sleep 1
done
grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" \
  || { echo "daemon never connected"; tail -40 "$LOGS/daemon.log"; exit 1; }

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d "{\"password\":\"$PODIUM_PASSWORD\"}" >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar"

echo "instance=$PODIUM_INSTANCE state=$PODIUM_RIG_STATE_ROOT agentHome=$AGENT_HOME port=$PODIUM_PORT sha=$HEAD_SHA"
date --iso-8601=seconds
