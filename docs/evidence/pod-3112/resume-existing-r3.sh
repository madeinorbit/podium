#!/usr/bin/env bash
# Resume the one reviewed r3 identity without rewriting its product-owned state.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

EXPECTED_INSTANCE=p3112-oc-paired-r3
EXPECTED_BASE=/tmp/pod-3112-paired-r3
EXPECTED_STATE_ROOT=/home/mgw/.local/state/podium/p3112-oc-paired-r3
EXPECTED_INSTANCE_UUID=91675e12-ada8-4cdd-a8ae-16ece13dd1a0
EXPECTED_PIN=d35c7ef7b630730f727365f25323427c67614386
EXPECTED_BUNDLE=f3d3d8f
EXPECTED_PROVIDER=/home/mgw/.opencode/bin/opencode
EXPECTED_PROVIDER_SHA=d91e0d33676d0839f7cde87924cd4127ea88c9d6784eea9f009a7d08bdc60eeb

refuse() { echo "refusing resume: $*" >&2; exit 2; }

[ "$P3112_INSTANCE" = "$EXPECTED_INSTANCE" ] || refuse "instance override: $P3112_INSTANCE"
[ "$PODIUM_INSTANCE" = "$EXPECTED_INSTANCE" ] || refuse "runtime instance mismatch: $PODIUM_INSTANCE"
[ "$P3112_BASE" = "$EXPECTED_BASE" ] || refuse "base override: $P3112_BASE"
[ "$PODIUM_DRIVE_BASE" = "$EXPECTED_BASE" ] || refuse "drive base mismatch: $PODIUM_DRIVE_BASE"
[ "$P3112_STATE_ROOT" = "$EXPECTED_STATE_ROOT" ] || refuse "state root mismatch: $P3112_STATE_ROOT"
[ "$PODIUM_RIG_STATE_ROOT" = "$EXPECTED_STATE_ROOT" ] || refuse "rig state root mismatch: $PODIUM_RIG_STATE_ROOT"
[ "$P3112_PORT" = 20313 ] && [ "$P3112_HOOK_PORT" = 47314 ] && [ "$P3112_RELAY_PORT" = 47315 ] \
  || refuse "port override"
[ "$P3112_PIN_SHA" = "$EXPECTED_PIN" ] || refuse "product pin override: $P3112_PIN_SHA"
[ "$P3112_OPENCODE_BIN" = "$EXPECTED_PROVIDER" ] || refuse "provider path override: $P3112_OPENCODE_BIN"
[ "$P3112_OPENCODE_SHA256" = "$EXPECTED_PROVIDER_SHA" ] || refuse "provider hash override"
[ "$PODIUM_DRIVE_REPO" = "$(git -C "$PODIUM_DRIVE_REPO" rev-parse --show-toplevel)" ] \
  || refuse "repository path is not its worktree root"

INSTANCE_JSON="$EXPECTED_STATE_ROOT/instance.json"
[ -f "$INSTANCE_JSON" ] || refuse "existing r3 instance marker absent: $INSTANCE_JSON"
python3 - "$INSTANCE_JSON" "$EXPECTED_INSTANCE" "$EXPECTED_INSTANCE_UUID" <<'PY'
import json, sys
path, expected, expected_uuid = sys.argv[1:]
with open(path, encoding='utf-8') as handle:
    marker = json.load(handle)
if marker.get('version') != 2 or marker.get('instanceId') != expected:
    raise SystemExit(f'refusing resume: unexpected instance marker {marker!r}')
uuid = marker.get('instanceUuid')
if uuid != expected_uuid:
    raise SystemExit(f'refusing resume: instance UUID drift: {uuid!r}')
print(f'existing identity instance={expected} uuid={uuid}')
PY

env PODIUM_RIG_STATE_ROOT="$P3112_STATE_ROOT" PODIUM_INSTANCE="$PODIUM_INSTANCE" \
  bun --conditions=@podium/source "$PODIUM_DRIVE_REPO/docs/evidence/state-root-check.ts"

git -C "$PODIUM_DRIVE_REPO" merge-base --is-ancestor "$EXPECTED_PIN" HEAD \
  || refuse "product pin is not an ancestor of HEAD"
git -C "$PODIUM_DRIVE_REPO" diff --quiet "$EXPECTED_PIN" HEAD -- . ':!docs' \
  || refuse "product tree differs from $EXPECTED_PIN"

STAMP="$PODIUM_DRIVE_REPO/apps/web/dist/podium-build.json"
[ -f "$STAMP" ] || refuse "web bundle stamp absent"
BUNDLE_SHA="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("sourceSha", ""))' "$STAMP")"
[ "$BUNDLE_SHA" = "$EXPECTED_BUNDLE" ] || refuse "bundle sourceSha drift: $BUNDLE_SHA"
git -C "$PODIUM_DRIVE_REPO" diff --quiet "$EXPECTED_BUNDLE" "$EXPECTED_PIN" -- apps/web \
  || refuse "bundle apps/web tree differs from exact product pin"
export PODIUM_WEB_DIR="$PODIUM_DRIVE_REPO/apps/web/dist"

RESOLVED_BIN="$(command -v opencode)"
[ "$RESOLVED_BIN" = "$EXPECTED_PROVIDER" ] || refuse "resolved provider drift: $RESOLVED_BIN"
ACTUAL_PROVIDER_SHA="$(sha256sum "$RESOLVED_BIN" | awk '{print $1}')"
[ "$ACTUAL_PROVIDER_SHA" = "$EXPECTED_PROVIDER_SHA" ] || refuse "provider bytes drift: $ACTUAL_PROVIDER_SHA"

for name in server daemon; do
  [ ! -e "$PODIUM_DRIVE_BASE/$name.pid" ] || refuse "$name pidfile already exists"
done
python3 - 20313 47314 47315 <<'PY'
import socket, sys
for raw in sys.argv[1:]:
    port = int(raw)
    sock = socket.socket()
    try:
        sock.bind(('127.0.0.1', port))
    except OSError as exc:
        raise SystemExit(f'refusing resume: port {port} occupied: {exc}')
    finally:
        sock.close()
PY

for proc in /proc/[0-9]*; do
  [ -r "$proc/environ" ] || continue
  if tr '\0' '\n' < "$proc/environ" 2>/dev/null | grep -Fxq "PODIUM_INSTANCE=$EXPECTED_INSTANCE"; then
    refuse "existing r3 process pid=${proc##*/}"
  fi
done

LOGS="$PODIUM_DRIVE_BASE/logs"
INITIAL_LOG_ARCHIVE="$LOGS/r3-initial"
[ ! -e "$INITIAL_LOG_ARCHIVE" ] \
  || refuse "initial log archive already exists: $INITIAL_LOG_ARCHIVE"
[ -f "$LOGS/server.log" ] || refuse "accepted initial server log absent"
[ -f "$LOGS/daemon.log" ] || refuse "accepted initial daemon log absent"
mkdir "$INITIAL_LOG_ARCHIVE"
mv "$LOGS/server.log" "$INITIAL_LOG_ARCHIVE/server.log"
mv "$LOGS/daemon.log" "$INITIAL_LOG_ARCHIVE/daemon.log"

AGENT_HOME="$EXPECTED_STATE_ROOT/agent-home"
CREDENTIAL="$AGENT_HOME/.local/share/opencode/auth.json"
SOURCE_CREDENTIAL="$HOME/.local/share/opencode/auth.json"
[ -d "$AGENT_HOME/.local/share/opencode" ] || refuse "existing isolated OpenCode directory absent"
[ -f "$SOURCE_CREDENTIAL" ] || refuse "live OpenCode credential absent"
[ ! -e "$CREDENTIAL" ] && [ ! -L "$CREDENTIAL" ] || refuse "isolated credential path already exists"
ln -s "$SOURCE_CREDENTIAL" "$CREDENTIAL"

cleanup_on_error() {
  status=$?
  if [ "$status" -ne 0 ]; then
    bash "$HERE/drive-down.sh" || true
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

start() {
  local name="$1" script="$2" pid
  (
    cd "$PODIUM_DRIVE_REPO"
    nohup setsid env \
      PODIUM_INSTANCE="$EXPECTED_INSTANCE" \
      PODIUM_PORT=20313 \
      PODIUM_HOOK_PORT=47314 \
      PODIUM_AGENT_RELAY_PORT=47315 \
      PODIUM_PASSWORD=p3112-oc-paired-r3 \
      PODIUM_NO_RELAY=1 \
      PODIUM_SPAWN_SHA="$EXPECTED_PIN" \
      PODIUM_WEB_DIR="$PODIUM_WEB_DIR" \
      OPENCODE_BIN="$EXPECTED_PROVIDER" \
      PODIUM_RUNTIME_CONTRACT=1 \
      PODIUM_CHAT_STREAMING=1 \
      PODIUM_LOG_LEVEL=debug \
      PATH="$PATH" \
      bun --conditions=@podium/source "$script" \
      > "$LOGS/$name.log" 2>&1 < /dev/null &
    pid=$!
    case "$pid" in ''|*[!0-9]*) refuse "invalid $name pid: $pid";; esac
    printf '%s\n' "$pid" > "$PODIUM_DRIVE_BASE/$name.pid"
  )
  printf '%s\n' "$EXPECTED_PIN" > "$PODIUM_DRIVE_BASE/$name.sha"
}

start server scripts/server.ts
for _ in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:20313/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:20313/health" >/dev/null || refuse "server never became healthy"

start daemon scripts/daemon.ts
for _ in $(seq 1 120); do
  grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" 2>/dev/null && break
  sleep 1
done
grep -q 'podium daemon up: connected to' "$LOGS/daemon.log" \
  || refuse "daemon never connected"

trap - EXIT
echo "resumed instance=$EXPECTED_INSTANCE state=$EXPECTED_STATE_ROOT ports=20313/47314/47315 pin=$EXPECTED_PIN"
