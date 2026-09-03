#!/usr/bin/env bash
# Start one production server+daemon+web pair at the exact fix pin. The pair is
# intentionally kept alive across both sequential driver cells.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
source "$HERE/drive-env.sh"

[ "$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)" = "$POD2920_PIN" ] || {
  echo "refusing: HEAD is not exact proof pin $POD2920_PIN" >&2
  exit 2
}

# A brand-new named instance can have product-derived empty runtime directories
# before saveConfig claims it. Remove only those known-empty directories, then
# let the normal runtime writer mint instance.json. Any contents make rmdir
# refuse closed; no adoption override or fabricated marker is used.
if [ ! -f "$P2777_STATE_ROOT/instance.json" ]; then
  rmdir "$P2777_STATE_ROOT/runtime/tmux" 2>/dev/null || true
  rmdir "$P2777_STATE_ROOT/runtime" 2>/dev/null || true
  bash "$PODIUM_DRIVE_REPO/docs/evidence/claim-instance.sh"
fi

bash "$PODIUM_DRIVE_REPO/docs/evidence/pod-2777/drive-up.sh"

# The operator's current Codex is 0.150.1, while this pinned product deliberately
# admits only 0.147.x-0.149.x for app-server. Use the already-installed 0.149.1
# binary inside this rig only; changing the operator's current symlink would
# affect unrelated sessions. Restarting the daemon is required because driver
# admission is fixed at daemon spawn.
SUPPORTED_CODEX="/home/mgw/.codex/packages/standalone/releases/0.149.1-x86_64-unknown-linux-musl/bin/codex"
[ -x "$SUPPORTED_CODEX" ] || { echo "supported Codex binary missing: $SUPPORTED_CODEX" >&2; exit 2; }
RIG_BIN="$PODIUM_DRIVE_BASE/supported-bin"
mkdir -p "$RIG_BIN"
ln -sfn "$SUPPORTED_CODEX" "$RIG_BIN/codex"
export PATH="$RIG_BIN:$PATH"
printf '%s\t%s\n' "$SUPPORTED_CODEX" "$("$SUPPORTED_CODEX" --version)" >"$PODIUM_DRIVE_BASE/codex-binary.tsv"

old_daemon="$(cat "$PODIUM_DRIVE_BASE/daemon.pid")"
kill "$old_daemon" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$old_daemon" 2>/dev/null || break; sleep 0.25; done
kill -9 "$old_daemon" 2>/dev/null || true
nohup bun --conditions=@podium/source scripts/daemon.ts >"$PODIUM_DRIVE_BASE/logs/daemon.log" 2>&1 &
echo "$!" >"$PODIUM_DRIVE_BASE/daemon.pid"
printf '%s\n' "$POD2920_PIN" >"$PODIUM_DRIVE_BASE/daemon.sha"
for _ in $(seq 1 120); do
  grep -q 'podium daemon up' "$PODIUM_DRIVE_BASE/logs/daemon.log" 2>/dev/null && break
  sleep 0.25
done
grep -q 'podium daemon up' "$PODIUM_DRIVE_BASE/logs/daemon.log" || {
  echo "isolated daemon did not restart with supported Codex" >&2
  tail -40 "$PODIUM_DRIVE_BASE/logs/daemon.log" >&2
  exit 2
}
echo "restarted isolated daemon pid=$(cat "$PODIUM_DRIVE_BASE/daemon.pid") with $("$SUPPORTED_CODEX" --version)"

# The served stamp is seven characters for product compatibility. Preserve the
# full source identity alongside it while HEAD is still the spawn source; the
# verifier requires this full pin plus the served stamp on every cell.
printf '%s\n' "$POD2920_PIN" >"$PODIUM_DRIVE_BASE/web.sha"

for driver in codex opencode; do
  cwd="$PODIUM_DRIVE_BASE/probes/${driver}-a1b"
  mkdir -p "$cwd"
  if [ ! -d "$cwd/.git" ]; then
    git -C "$cwd" init -q -b main
  fi
done

echo "POD-2920 instance ready: $PODIUM_INSTANCE at $POD2920_PIN"
