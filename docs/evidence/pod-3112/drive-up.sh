#!/usr/bin/env bash
# Bring up a fresh named instance: server + daemon + reused web bundle.
# Does not spawn OpenCode. Symlinks the existing OpenCode credential into the isolated agent home.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
PIN_SHA="$P3112_PIN_SHA"
if ! git -C "$PODIUM_DRIVE_REPO" merge-base --is-ancestor "$PIN_SHA" HEAD; then
  echo "refusing: pin $PIN_SHA is not an ancestor of HEAD" >&2
  exit 2
fi
if ! git -C "$PODIUM_DRIVE_REPO" diff --quiet "$PIN_SHA" HEAD -- . ':!docs'; then
  echo "refusing: product tree differs from pin $PIN_SHA" >&2
  exit 2
fi
HEAD_SHA="$PIN_SHA"
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

AGENT_HOME="$P3112_STATE_ROOT/agent-home"
mkdir -p "$AGENT_HOME/.local/share/opencode" "$AGENT_HOME/.config/opencode" "$PODIUM_DRIVE_BASE/probes"
chmod 700 "$AGENT_HOME"
[ -f "$HOME/.local/share/opencode/auth.json" ] || { echo "refusing: live OpenCode credential absent" >&2; exit 2; }
ln -s "$HOME/.local/share/opencode/auth.json" "$AGENT_HOME/.local/share/opencode/auth.json"
if [ -f "$HOME/.config/opencode/opencode.jsonc" ]; then ln -s "$HOME/.config/opencode/opencode.jsonc" "$AGENT_HOME/.config/opencode/opencode.jsonc"; fi

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
      OPENCODE_BIN="$P3112_OPENCODE_BIN" \
      PODIUM_RUNTIME_CONTRACT="$PODIUM_RUNTIME_CONTRACT" \
      PODIUM_CHAT_STREAMING="$PODIUM_CHAT_STREAMING" \
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

RESOLVED_BIN="$(command -v opencode)"
[ "$RESOLVED_BIN" = "$P3112_OPENCODE_BIN" ] || { echo "refusing: resolved binary $RESOLVED_BIN" >&2; exit 2; }
ACTUAL_BIN_HASH="$(sha256sum "$RESOLVED_BIN" | awk '{print $1}')"
[ "$ACTUAL_BIN_HASH" = "$P3112_OPENCODE_SHA256" ] || { echo "refusing: OpenCode hash drift $ACTUAL_BIN_HASH" >&2; exit 2; }
echo "instance=$PODIUM_INSTANCE state=$P3112_STATE_ROOT agentHome=$AGENT_HOME port=$PODIUM_PORT"
echo "OpenCode credential posture=symlink"
echo "opencode binary: $(command -v opencode)"
echo "opencode version: $(opencode --version 2>/dev/null | head -1)"
sha256sum "$RESOLVED_BIN"
date --iso-8601=seconds
