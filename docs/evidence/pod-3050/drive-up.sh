#!/usr/bin/env bash
# Bring up a fresh named instance: server + daemon + reused web bundle.
# Does not spawn Claude. Does not copy or read credential files. TOS on daemon.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
# THE PIN IS WHATEVER IS CHECKED OUT, and the tree must match it exactly.
#
# This rig runs the same cell twice against two DIFFERENT commits — the fix and
# a control whose product tree is byte-identical to the pre-fix tip. A pin
# hard-coded to one sha cannot describe both arms, and a pin that tolerated a
# dirty tree would let an arm measure edits nobody can name afterwards. So the
# pin is HEAD, and an uncommitted product change stops the bring-up.
PIN_SHA="${P3050_PIN_SHA:-$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)}"
if [ "$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)" != "$PIN_SHA" ]; then
  echo "refusing: checkout is not at pin $PIN_SHA" >&2
  exit 2
fi
if ! git -C "$PODIUM_DRIVE_REPO" diff --quiet HEAD -- . ':!docs'; then
  echo "refusing: product tree is dirty against $PIN_SHA" >&2
  exit 2
fi
HEAD_SHA="$PIN_SHA"
WEB_REUSE_FROM="${P3050_REUSE_WEB_FROM:-/home/mgw/src/podium/.worktrees/issue-1761-agent-runtime}"
mkdir -p "$LOGS"
chmod 700 "$PODIUM_DRIVE_BASE"

if [ -e "$PODIUM_RIG_STATE_ROOT/instance.json" ]; then
  echo "refusing reused state root: $PODIUM_RIG_STATE_ROOT" >&2
  exit 2
fi

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
bash "$PODIUM_DRIVE_REPO/docs/evidence/claim-instance.sh"
( cd "$PODIUM_DRIVE_REPO" && bun --conditions=@podium/source "$PODIUM_DRIVE_REPO/docs/evidence/state-root-check.ts" )

# The web bundle is REUSED, not rebuilt: this issue changes no file under
# apps/web, and the pin below records the served bundle's source sha plus a
# `git diff` proving apps/web is identical from that sha through HEAD. A rebuild
# would take longer and prove less.
if [ ! -e "$PODIUM_DRIVE_REPO/apps/web/dist/podium-build.json" ]; then
  if [ ! -e "$WEB_REUSE_FROM/apps/web/dist/podium-build.json" ]; then
    echo "no web bundle to reuse at $WEB_REUSE_FROM/apps/web/dist" >&2
    exit 1
  fi
  ln -sfn "$WEB_REUSE_FROM/apps/web/dist" "$PODIUM_DRIVE_REPO/apps/web/dist"
  echo "linked web bundle from $WEB_REUSE_FROM"
fi

STAMP="$PODIUM_DRIVE_REPO/apps/web/dist/podium-build.json"
if [ ! -f "$STAMP" ]; then
  echo "web bundle missing at $STAMP" >&2
  exit 1
fi
BUNDLE_SHA="$(python3 -c 'import json; print(json.load(open("'"$STAMP"'")).get("sourceSha",""))')"
WANT_SHORT="$(git -C "$PODIUM_DRIVE_REPO" rev-parse --short=7 HEAD)"
if [ "$BUNDLE_SHA" != "$WANT_SHORT" ]; then
  if ! git -C "$PODIUM_DRIVE_REPO" diff --quiet "$BUNDLE_SHA" HEAD -- apps/web; then
    echo "cannot reuse web bundle $BUNDLE_SHA: apps/web differs from HEAD $WANT_SHORT" >&2
    exit 1
  fi
  echo "reusing web bundle sourceSha=$BUNDLE_SHA; apps/web identical through HEAD $WANT_SHORT"
else
  echo "web bundle already at $WANT_SHORT"
fi
export PODIUM_WEB_DIR="$PODIUM_DRIVE_REPO/apps/web/dist"

AGENT_HOME="$PODIUM_RIG_STATE_ROOT/agent-home"
mkdir -p "$AGENT_HOME/.claude" "$PODIUM_DRIVE_BASE/probes"
chmod 700 "$AGENT_HOME" "$AGENT_HOME/.claude"
if [ -e "$AGENT_HOME/.claude/.credentials.json" ]; then
  echo "refusing: isolated credential present at $AGENT_HOME/.claude/.credentials.json" >&2
  exit 2
fi

# Trust/onboarding only. No credential copy.
SOURCE_STATE="$HOME/.claude.json" TARGET_STATE="$AGENT_HOME/.claude.json" bun -e '
  const source = process.env.SOURCE_STATE
  const target = process.env.TARGET_STATE
  if (!source || !target) throw new Error("Claude state paths missing")
  const live = await Bun.file(source).exists() ? JSON.parse(await Bun.file(source).text()) : {}
  const state = {
    hasCompletedOnboarding: live.hasCompletedOnboarding === true,
    ...(typeof live.lastOnboardingVersion === "string" ? { lastOnboardingVersion: live.lastOnboardingVersion } : {}),
  }
  if (!state.hasCompletedOnboarding) throw new Error("live Claude state does not report completed onboarding")
  await Bun.write(target, JSON.stringify(state, null, 2) + "\n")
  Bun.spawnSync(["chmod", "600", target])
  console.log("seeded claude onboarding/trust state only; no credential file written")
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
      PODIUM_WEB_DIR="$PODIUM_WEB_DIR" \
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
  echo "started $name pid=$(<"$PODIUM_DRIVE_BASE/$name.pid") sha=$HEAD_SHA tos=1"
}

start server scripts/server.ts
for _ in $(seq 1 120); do
  curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null \
  || { echo "server never served /health — see $LOGS/server.log"; tail -40 "$LOGS/server.log"; exit 1; }
echo "server healthy on :$PODIUM_PORT"

start daemon scripts/daemon.ts
for _ in $(seq 1 120); do
  grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" 2>/dev/null && break
  sleep 1
done
grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" \
  || { echo "daemon never connected — see $LOGS/daemon.log"; tail -40 "$LOGS/daemon.log"; exit 1; }

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d "{\"password\":\"$PODIUM_PASSWORD\"}" >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar"

WEB="$(python3 - <<PY
import json, urllib.request
print(json.load(urllib.request.urlopen('http://127.0.0.1:$PODIUM_PORT/podium-build.json')))
PY
)"
echo "served web $WEB"

echo "instance=$PODIUM_INSTANCE state=$PODIUM_RIG_STATE_ROOT agentHome=$AGENT_HOME port=$PODIUM_PORT"
echo "TOS=PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1 on daemon; credentials not copied"
echo "claude --version: $(command -v claude) $(claude --version 2>/dev/null | head -1)"
date --iso-8601=seconds
