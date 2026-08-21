#!/usr/bin/env bash
# Mac execution proof for a Linux-cross-built darwin-arm64 headless payload (POD-2501 follow-up).
# Run on an Apple Silicon Mac after unpacking the Mac verification bundle.
#
# Bundle layout (produced by scripts/spike/package-mac-execution-bundle.sh):
#   mac-execution-bundle/
#     verify-on-mac.sh          ← this file (copied as verify-on-mac.sh)
#     podium-headless-<platform>.tar.gz     ← updater layout (root = headless/)
#     podium-cli.nosig          ← same binary, signature removed (unsigned probe)
#     README.md
#
# Usage:
#   cd mac-execution-bundle && bash verify-on-mac.sh
#
# Prints a PASS/FAIL matrix and exits non-zero if any required check fails.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
TARBALL="$(ls "$BUNDLE_DIR"/podium-headless-darwin-*.tar.gz 2>/dev/null | head -1)"
WORK="$(mktemp -d /tmp/podium-mac-proof-XXXXXX)"
STATE="$WORK/state"
LOG="$WORK/verify.log"
MATRIX="$WORK/matrix.txt"
: >"$MATRIX"

exec > >(tee -a "$LOG") 2>&1

pass() { echo "PASS  $*" | tee -a "$MATRIX"; }
fail() { echo "FAIL  $*" | tee -a "$MATRIX"; FAILED=1; }
warn() { echo "WARN  $*" | tee -a "$MATRIX"; }
FAILED=0

echo "=== Mac execution proof ==="
echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host: $(uname -a)"
echo "arch: $(uname -m)"
echo "bundle: $BUNDLE_DIR"
echo "work: $WORK"
echo

[[ "$(uname -s)" == "Darwin" ]] || { echo "FATAL: not Darwin"; exit 2; }
[[ -n "$TARBALL" && -f "$TARBALL" ]] || { echo "FATAL: no podium-headless-darwin-*.tar.gz in $BUNDLE_DIR"; exit 2; }

tar -xzf "$TARBALL" -C "$WORK"
CLI="$WORK/headless/podium-cli"
LAUNCHER="$WORK/headless/podium"
[[ -x "$CLI" ]] || { echo "FATAL: no headless/podium-cli after extract"; exit 2; }

echo "--- file / codesign ---"
file "$CLI" || true
codesign -dv --verbose=4 "$CLI" 2>&1 || true
echo

# `codesign -dv` only DISPLAYS a signature; it does not validate the seal.
# This is the check that says whether an rcodesign-produced signature is
# acceptable to Apple's own verifier.
echo "--- codesign --verify --strict ---"
if codesign --verify --strict --verbose=4 "$CLI" 2>&1; then
  pass "codesign: --verify --strict accepts the rcodesign ad-hoc signature"
else
  fail "codesign: --verify --strict REJECTED the rcodesign ad-hoc signature"
fi
echo

echo "--- entitlements ---"
ents="$(codesign -d --entitlements - --xml "$CLI" 2>/dev/null || codesign -d --entitlements - "$CLI" 2>/dev/null || true)"
echo "$ents"
if echo "$ents" | grep -q 'com.apple.security.cs.allow-jit'; then
  pass "entitlements: allow-jit present on the shipped binary"
else
  fail "entitlements: allow-jit MISSING — Bun's JIT will not be permitted"
fi
echo

# --- version ---
if out="$("$CLI" --version 2>&1)"; then
  echo "$out"
  echo "$out" | grep -qi 'podium' && pass "version: podium-cli --version runs" || fail "version: output missing 'podium'"
else
  fail "version: podium-cli --version exited non-zero"
fi

# --- Gatekeeper / quarantine ---
xattr -l "$CLI" 2>&1 || true
if "$CLI" --version >/dev/null 2>&1; then
  pass "gatekeeper: runs without quarantine xattr"
else
  fail "gatekeeper: fails without quarantine xattr"
fi
xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;00000000-0000-0000-0000-000000000000" "$CLI" 2>/dev/null || true
set +e
q_out="$("$CLI" --version 2>&1)"
q_rc=$?
set -e
echo "with quarantine: exit=$q_rc"
echo "$q_out" | head -5
# Record both outcomes; stripping and re-running is the required recovery path.
xattr -d com.apple.quarantine "$CLI" 2>/dev/null || xattr -c "$CLI" 2>/dev/null || true
if "$CLI" --version >/dev/null 2>&1; then
  pass "gatekeeper: runs after quarantine stripped"
else
  fail "gatekeeper: still fails after quarantine stripped"
fi
if [[ $q_rc -ne 0 ]]; then
  pass "gatekeeper: quarantine blocked execution (expected on real Macs)"
else
  warn "gatekeeper: quarantine did not block (AMFI may be lenient on this host)"
fi

# --- unsigned must be REFUSED on arm64 ---
# The spike's original probe used the build's `podium.unsigned`, which was never
# unsigned: `bun build --compile --target=bun-darwin-*` already emits an ad-hoc
# LINKER_SIGNED Mach-O. It ran, and that was misread as "AMFI is lenient".
# podium-cli.nosig has had its LC_CODE_SIGNATURE removed for real.
NOSIG="$BUNDLE_DIR/podium-cli.nosig"
if [[ -f "$NOSIG" ]]; then
  cp "$NOSIG" "$WORK/podium-cli.nosig"
  chmod +x "$WORK/podium-cli.nosig"
  echo "--- unsigned probe ---"
  codesign -dv "$WORK/podium-cli.nosig" 2>&1 | head -3 || true
  set +e
  u_out="$("$WORK/podium-cli.nosig" --version 2>&1)"
  u_rc=$?
  set -e
  echo "unsigned exit=$u_rc"
  echo "$u_out" | head -5
  if [[ $u_rc -ne 0 ]]; then
    pass "unsigned: a signature-stripped binary is refused on arm64 (exit $u_rc)"
  else
    fail "unsigned: a signature-stripped binary RAN — this host does not enforce the arm64 signature requirement, so nothing here proves the signature is load-bearing"
  fi
  echo
else
  warn "unsigned: podium-cli.nosig not in the bundle — signature requirement not probed"
fi

# --- daemon / all-in-one boot on throwaway state ---
export PODIUM_STATE_DIR="$STATE"
export PODIUM_HOME="$WORK/headless"
export PODIUM_WEB_DIR="$WORK/headless/web"
export PODIUM_MOBILE_WEB_DIR="$WORK/headless/mobile"
export PODIUM_PORT="${PODIUM_PORT:-$((19000 + RANDOM % 1000))}"
mkdir -p "$PODIUM_STATE_DIR"

"$CLI" all-in-one >"$WORK/daemon.log" 2>&1 &
echo $! >"$WORK/daemon.pid"
alive=0
for _ in $(seq 1 20); do
  if ! kill -0 "$(cat "$WORK/daemon.pid")" 2>/dev/null; then break; fi
  if [[ -x "$PODIUM_STATE_DIR/bin/abduco" ]] && grep -q 'daemon up\|server up' "$WORK/daemon.log" 2>/dev/null; then
    alive=1
    break
  fi
  sleep 1
done
echo "--- daemon.log (tail) ---"
tail -60 "$WORK/daemon.log" || true
if [[ $alive -eq 1 ]] && kill -0 "$(cat "$WORK/daemon.pid")" 2>/dev/null; then
  pass "daemon: all-in-one boot on throwaway PODIUM_STATE_DIR"
else
  fail "daemon: all-in-one did not stay up / no server|daemon up line"
fi
if [[ -x "$PODIUM_STATE_DIR/bin/abduco" ]]; then
  "$PODIUM_STATE_DIR/bin/abduco" -v 2>&1 | head -3
  pass "abduco: embedded helper materialized under state dir"
else
  fail "abduco: embedded helper not materialized"
fi

# --- abduco spawn + reattach / survive restart ---
ABDUCO_BIN="${PODIUM_STATE_DIR}/bin/abduco"
SESS="podium-mac-proof-$$"
set +e
"$ABDUCO_BIN" -n "$SESS" /bin/sleep 120
c_rc=$?
set -e
if [[ $c_rc -eq 0 ]] && "$ABDUCO_BIN" -l 2>&1 | grep -qF "$SESS"; then
  pass "abduco: session spawned (-n $SESS)"
else
  fail "abduco: session spawn failed (rc=$c_rc)"
fi
# Kill all-in-one (daemon restart stand-in); session must remain.
if [[ -f "$WORK/daemon.pid" ]]; then
  kill "$(cat "$WORK/daemon.pid")" 2>/dev/null || true
  sleep 1
fi
if "$ABDUCO_BIN" -l 2>&1 | grep -qF "$SESS"; then
  pass "abduco: session survives daemon kill (reattach/survival)"
else
  fail "abduco: session vanished after daemon kill"
fi
# Cleanup session
pkill -f "abduco.*$SESS" 2>/dev/null || true

echo
echo "=== MATRIX ==="
cat "$MATRIX"
echo
echo "log: $LOG"
if [[ "$FAILED" -ne 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
exit 0
