#!/usr/bin/env bash
# Mac-side verification for POD-2501 Darwin cross-compile spike.
# Run on an Apple Silicon Mac after unpacking the spike tarball.
#
# Usage:
#   tar -xzf podium-headless-spike-darwin-arm64.tar.gz
#   cd <unpack-dir>   # contains headless/, podium, podium.unsigned, abduco
#   bash mac-verify.sh
#
# Environment:
#   SPIKE_DIR   — directory with the unpacked spike (default: cwd)
#   KEEP_STATE  — if set, leave /tmp/podium-spike-* state dirs around
set -euo pipefail

SPIKE_DIR="${SPIKE_DIR:-$(pwd)}"
SIGNED="${SPIKE_DIR}/headless/podium-cli"
UNSIGNED="${SPIKE_DIR}/podium.unsigned"
ABDUCO="${SPIKE_DIR}/abduco"
STATE="$(mktemp -d /tmp/podium-spike-XXXXXX)"
LOG="${STATE}/verify.log"

exec > >(tee -a "$LOG") 2>&1

echo "=== POD-2501 Mac verification ==="
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host: $(uname -a)"
echo "arch: $(uname -m)"
echo "spike: $SPIKE_DIR"
echo "state: $STATE"
echo

die() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

[[ -x "$SIGNED" ]] || die "missing signed binary $SIGNED"
[[ -x "$UNSIGNED" ]] || die "missing unsigned binary $UNSIGNED"
[[ -x "$ABDUCO" ]] || die "missing abduco $ABDUCO"

echo "--- file(1) ---"
file "$SIGNED" "$UNSIGNED" "$ABDUCO"
echo
echo "--- codesign -dv ---"
codesign -dv --verbose=4 "$SIGNED" 2>&1 || true
echo
codesign -dv --verbose=4 "$ABDUCO" 2>&1 || true
echo

echo "--- Gatekeeper / quarantine ---"
echo "xattr signed (expect empty or no com.apple.quarantine):"
xattr -l "$SIGNED" 2>&1 || true
# Simulate app-downloaded quarantine, then strip (historical fs::copy failure mode).
xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;00000000-0000-0000-0000-000000000000" "$SIGNED" || true
echo "xattr after planting quarantine:"
xattr -l "$SIGNED" 2>&1 || true
xattr -d com.apple.quarantine "$SIGNED" 2>/dev/null || xattr -c "$SIGNED" || true
echo "xattr after strip:"
xattr -l "$SIGNED" 2>&1 || true
pass "quarantine plant+strip exercised"

echo
echo "--- 1) unsigned should fail on arm64 (signature requirement) ---"
set +e
UNSIGNED_OUT="$( "$UNSIGNED" --version 2>&1 )"
UNSIGNED_RC=$?
set -e
echo "unsigned exit=$UNSIGNED_RC"
echo "$UNSIGNED_OUT" | head -20
if [[ "$(uname -m)" == "arm64" ]]; then
  if [[ $UNSIGNED_RC -ne 0 ]]; then
    pass "unsigned binary refused (rc=$UNSIGNED_RC)"
  else
    echo "WARN: unsigned --version succeeded on arm64 — unexpected; record as anomaly"
  fi
else
  echo "NOTE: host is $(uname -m); unsigned refusal is primarily an arm64 Gatekeeper/AMFI rule"
fi

echo
echo "--- 2) signed --version ---"
VER_OUT="$( "$SIGNED" --version 2>&1 )" || die "signed --version failed: $VER_OUT"
echo "$VER_OUT"
pass "signed --version"

echo
echo "--- 3/4) daemon boot (bun:sqlite + discovery-worker + embedded abduco materialize) ---"
export PODIUM_STATE_DIR="$STATE/state"
export PODIUM_HOME="$SPIKE_DIR/headless"
export PODIUM_WEB_DIR="$SPIKE_DIR/headless/web"
export PODIUM_MOBILE_WEB_DIR="$SPIKE_DIR/headless/mobile"
# Ephemeral ports so we never collide with a real install.
export PODIUM_PORT="${PODIUM_PORT:-$((18000 + RANDOM % 1000))}"
mkdir -p "$PODIUM_STATE_DIR"
INSTANCE="spike-$(date +%s)"
echo "instance=$INSTANCE state=$PODIUM_STATE_DIR port=$PODIUM_PORT"

# Prefer all-in-one (server+daemon in one process). Bare `daemon` needs a serverUrl.
"$SIGNED" all-in-one >"$STATE/daemon.log" 2>&1 &
echo $! >"$STATE/daemon.pid"
# Give sqlite store + mirror bootstrap a moment on a cold runner.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [[ -x "$PODIUM_STATE_DIR/bin/abduco" ]]; then break; fi
  sleep 1
done
sleep 2
if kill -0 "$(cat "$STATE/daemon.pid")" 2>/dev/null; then
  pass "all-in-one still alive after boot wait (pid $(cat "$STATE/daemon.pid"))"
else
  echo "WARN: all-in-one exited early — log:"
  tail -80 "$STATE/daemon.log" || true
fi
echo "--- daemon.log (tail) ---"
tail -80 "$STATE/daemon.log" || true
echo "--- materialized abduco under state dir ---"
find "$PODIUM_STATE_DIR" -name abduco -type f 2>/dev/null | head -20 || true
ls -la "$PODIUM_STATE_DIR/bin" 2>/dev/null || true
if [[ -x "$PODIUM_STATE_DIR/bin/abduco" ]]; then
  "$PODIUM_STATE_DIR/bin/abduco" -v 2>&1 || die "materialized abduco -v failed"
  pass "embedded abduco materialized and runs"
else
  # --version already materializes into ~/.podium/bin when STATE_DIR unset; force here.
  die "no $PODIUM_STATE_DIR/bin/abduco — materializeEmbeddedAbduco did not run"
fi

echo
echo "--- 5) abduco self-check ---"
"$ABDUCO" -v 2>&1 || die "standalone abduco -v failed"
pass "standalone prebuilt abduco -v"

# Create a disposable abduco session, kill the 'daemon' stand-in conceptually by
# checking the session survives independently.
SESS="podium-spike-$$"
# abduco has no GNU-style `--`; the next argv IS the command.
set +e
"$ABDUCO" -n "$SESS" /bin/sleep 120
ABDUCO_CREATE=$?
set -e
[[ $ABDUCO_CREATE -eq 0 ]] || die "abduco -n $SESS failed (rc=$ABDUCO_CREATE)"
"$ABDUCO" -l 2>&1 | grep -F "$SESS" || die "session $SESS not listed"
pass "abduco session created"

# Simulate daemon restart: kill all-in-one if still up; session must remain.
if [[ -f "$STATE/daemon.pid" ]]; then
  kill "$(cat "$STATE/daemon.pid")" 2>/dev/null || true
  wait "$(cat "$STATE/daemon.pid")" 2>/dev/null || true
  rm -f "$STATE/daemon.pid"
fi
sleep 1
"$ABDUCO" -l 2>&1 | grep -F "$SESS" || die "session vanished after killing all-in-one"
pass "abduco session survives without attached client (daemon-restart stand-in)"

# Detach/cleanup: send CTRL-A \\ equivalent via -e / kill session key if present.
"$ABDUCO" -e "$SESS" 2>/dev/null || true
# Force-reap leftover sleep master if still listed.
if "$ABDUCO" -l 2>&1 | grep -qF "$SESS"; then
  pkill -f "abduco.*$SESS" 2>/dev/null || true
fi

echo
echo "=== SUMMARY ==="
echo "log: $LOG"
echo "state: $STATE"
if [[ -z "${KEEP_STATE:-}" ]]; then
  # Stop background daemon if we started one.
  if [[ -f "$STATE/daemon.pid" ]]; then
    kill "$(cat "$STATE/daemon.pid")" 2>/dev/null || true
  fi
fi
echo "Paste this log into POD-2501 / spec §8b as Mac evidence."
pass "mac-verify completed (review WARN lines before GO)"
