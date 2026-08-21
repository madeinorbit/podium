#!/usr/bin/env bash
# E2E desktop update verification. Builds v0.1.0 and v0.1.1 once, then runs two arms
# against a local signed feed, both driving the on-disk v0.1.0 AppImage under Xvfb:
#
#   ARM A (negative): the feed serves a CORRUPTED v0.1.1 with the genuine signature.
#     The update must fail closed — the v0.1.0 AppImage stays byte-identical and still
#     launches, still reporting 0.1.0.
#   ARM B (positive): the feed serves the genuine v0.1.1. The update must land — the
#     on-disk AppImage re-run reports 0.1.1.
#
# BOTH ARMS DRIVE THE NATIVE FALLBACK, and that is a precondition they cannot assume.
# The fallback only runs when the page has not claimed update ownership inside the 8 s
# grace window, and the shipped web bundle DOES claim it — the update panel claims on
# mount. So a boot where the page comes up in time takes the bridge path instead and both
# arms quietly stop testing anything: ARM A's "intact + launchable" is trivially true and
# ARM B simply fails without saying why. Each arm therefore reads the branch the shell
# recorded in $PODIUM_STATE_DIR/update-ownership and reports INCONCLUSIVE, naming that
# cause, rather than a vacuous pass or an unexplained failure (POD-2104).
#
# The arms run sequentially on the same port. Each isolated state directory selects the
# dev channel and persists this feed's static latest.json endpoint. Exit: 0 both verified,
# 2 no upgrade, 3 the corrupted artifact was not
# rejected (3 wins — a bad artifact getting through is worse than an update not landing).
#
# The full chain exercised: updater.check() reaches the feed -> sees 0.1.1 ->
# downloads the artifact -> verifies the minisign signature against the baked-in
# pubkey -> installs (self-replaces $APPIMAGE) -> app.restart() -> the restarted
# process is 0.1.1.
#
# Version assertion: the app writes app.package_info().version to
# $PODIUM_STATE_DIR/running-version on every boot (main.rs setup). After the
# self-replace+restart that file should flip 0.1.0 -> 0.1.1.
#
# KNOWN RISK: Tauri's AppImage updater self-replaces the file at $APPIMAGE. Under
# headless Xvfb with no FUSE the AppImage runs via --appimage-extract-and-run and
# $APPIMAGE self-replacement may not happen. This script therefore records EXACTLY
# which stages succeeded (check / download / signature / install+restart) so a
# partial result is reported honestly rather than as a false pass.
set -uo pipefail
cd "$(dirname "$0")/.."   # apps/desktop
export PATH="$HOME/.cargo/bin:$PATH"
export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri-dev-signing.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

PORT="${PODIUM_FEED_PORT:-8788}"
TAURI_BIN="./node_modules/.bin/tauri"
CONF="src-tauri/tauri.conf.json"

# Back up the pristine committed config + package.json and restore them on exit. The
# committed config is intentionally HTTPS-only (secure default); the local verification
# feed is plain http://127.0.0.1, so the builds below temporarily enable
# `dangerousInsecureTransportProtocol` — a TEST-ONLY relaxation that must NOT ship.
# The builds also bump the version in both files; restoring leaves a clean tree.
CONF_BAK="$(mktemp)"; PKG_BAK="$(mktemp)"
cp "$CONF" "$CONF_BAK"; cp package.json "$PKG_BAK"
restore_conf() { cp "$CONF_BAK" "$CONF"; cp "$PKG_BAK" package.json; rm -f "$CONF_BAK" "$PKG_BAK"; }

set_version() { # $1 = version — Tauri reads version from tauri.conf.json.
  # Permit the http:// test endpoint. Runtime channel selection below replaces the baked URL.
  node -e "const fs=require('fs');const f='$CONF';const o=JSON.parse(fs.readFileSync(f,'utf8'));o.version='$1';o.plugins=o.plugins||{};o.plugins.updater=o.plugins.updater||{};o.plugins.updater.dangerousInsecureTransportProtocol=true;o.plugins.updater.endpoints=['http://127.0.0.1:$PORT/update/{{target}}/{{arch}}/{{current_version}}'];fs.writeFileSync(f,JSON.stringify(o,null,2)+'\n')"
  node -e "const fs=require('fs');const f='package.json';const o=JSON.parse(fs.readFileSync(f,'utf8'));o.version='$1';fs.writeFileSync(f,JSON.stringify(o,null,2)+'\n')"
}

configure_dev_feed() { # $1 = isolated desktop state directory
  mkdir -p "$1"
  node -e "const fs=require('fs');const dir='$1';const config={updateChannel:'dev',updateFeedEndpoint:'http://127.0.0.1:$PORT/updates/feed/dev/latest.json'};fs.writeFileSync(dir+'/config.json',JSON.stringify(config,null,2)+'\n')"
}

build() { # $1 = version
  # Artifact reuse: a prior run may have already staged this version's AppImage+sig.
  # Both are deterministic for a given source tree, so reuse them and skip the ~4-min
  # release rebuild. Only rebuild a version whose artifact (or its sig) is missing.
  if [ -f "dist-verify/$1/Podium_$1_amd64.AppImage" ] && [ -f "dist-verify/$1/Podium_$1_amd64.AppImage.sig" ]; then
    echo "=== BUILD v$1 SKIPPED — reusing existing dist-verify/$1/ artifacts ==="
    ls -la "dist-verify/$1/"
    return 0
  fi
  echo "=== BUILD v$1 START $(date -Is) ==="
  set_version "$1"
  bun run stage
  "$TAURI_BIN" build
  local rc=$?
  if [ $rc -ne 0 ]; then echo "=== BUILD v$1 FAILED rc=$rc ==="; return $rc; fi
  mkdir -p "dist-verify/$1"
  cp -f src-tauri/target/release/bundle/appimage/Podium_$1_amd64.AppImage  "dist-verify/$1/"
  cp -f src-tauri/target/release/bundle/appimage/Podium_$1_amd64.AppImage.sig "dist-verify/$1/"
  echo "=== BUILD v$1 OK $(date -Is) — staged dist-verify/$1/ ==="
  ls -la "dist-verify/$1/"
}

# Restore the pristine committed config no matter how we exit.
trap 'restore_conf' EXIT

# --- two release builds -----------------------------------------------------
build 0.1.0 || { echo "ABORT: v0.1.0 build failed"; exit 1; }
build 0.1.1 || { echo "ABORT: v0.1.1 build failed"; exit 1; }

# --- single-instance pre-flight guard ---------------------------------------
# tauri_plugin_single_instance holds a lock; a STALE Podium instance makes a
# fresh launch focus-the-existing-window-and-exit BEFORE setup() runs, so running-version
# is never written and the upgrade is silently a no-op (false negative / false positive).
# Kill any stale desktop instances so the lock is free. NEVER touch the live systemd
# podium-server / :18787 — these patterns only match the desktop AppImage + its mounts.
kill_stale_desktop() {
  # `bin/Podium`, not a bare `Podium`: the desktop executable is the bin target
  # of that name (target/*/Podium, usr/bin/Podium inside the AppImage), and the
  # narrower pattern cannot reach for the live podium-server. Case matters here
  # — every path of the server's is lowercase.
  pkill -f 'bin/Podium' 2>/dev/null || true
  pkill -f '/tmp/.mount_Podium' 2>/dev/null || true
  pkill -f 'appimage_extracted' 2>/dev/null || true
  sleep 2
}

# --- ARM A: a corrupted artifact must fail closed ---------------------------
# The updater must refuse an artifact whose bytes do not match the signed digest.
# "Fails closed" here means BOTH: the on-disk AppImage is left byte-for-byte intact,
# AND it still boots afterwards still reporting its ORIGINAL version. A half-written
# or replaced-then-broken AppImage is the dangerous outcome this arm exists to catch.
#
# This arm persists the dev feed endpoint into its isolated config and runs on the SAME
# $PORT, sequentially, BEFORE the good
# feed of ARM B starts.
#
# ARMEDNESS: "intact + launchable" is also what you get if the app never checked for an
# update at all, so those assertions alone cannot say NO. The corrupt feed's stderr is
# captured and the arm REQUIRES evidence that the artifact was actually requested;
# without that download the arm reports INCONCLUSIVE rather than a vacuous pass.
CORRUPT_DIR="$(mktemp -d)"
cp "dist-verify/0.1.1/Podium_0.1.1_amd64.AppImage"     "$CORRUPT_DIR/"
# Keep the GENUINE signature: the manifest still advertises a valid minisign signature
# for the pristine 0.1.1 bytes while the served bytes are damaged — exactly the shape of
# a tampered or corrupted download.
cp "dist-verify/0.1.1/Podium_0.1.1_amd64.AppImage.sig" "$CORRUPT_DIR/"
CORRUPT_APP="$CORRUPT_DIR/Podium_0.1.1_amd64.AppImage"
CORRUPT_SIZE=$(stat -c%s "$CORRUPT_APP")
# Overwrite 4 KiB in the middle, same total length — only the signature can catch this.
dd if=/dev/urandom of="$CORRUPT_APP" bs=4096 seek=$(( CORRUPT_SIZE / 8192 )) count=1 \
  conv=notrunc status=none
echo "=== ARM A: serving CORRUPTED v0.1.1 (4 KiB damaged at offset $(( CORRUPT_SIZE / 2 ))) on :$PORT ==="

bun scripts/serve-update-feed.ts "$CORRUPT_DIR" 0.1.1 "$PORT" >/tmp/corrupt-feed.log 2>&1 &
BAD_FEED=$!
trap 'kill $BAD_FEED 2>/dev/null || true; restore_conf' EXIT
sleep 1

# A dedicated COPY of the v0.1.0 AppImage: ARM B below needs the original untouched, and
# this arm must be free to observe damage without destroying it.
BAD_ARM_DIR="$(mktemp -d)"
BAD_APP010="$BAD_ARM_DIR/Podium_0.1.0_amd64.AppImage"
cp "dist-verify/0.1.0/Podium_0.1.0_amd64.AppImage" "$BAD_APP010"
chmod +x "$BAD_APP010"
BAD_ABS="$(readlink -f "$BAD_APP010")"
BAD_HASH_PRE="$(sha256sum "$BAD_ABS" | cut -d' ' -f1)"
BAD_STATE="$(mktemp -d)"
configure_dev_feed "$BAD_STATE"
kill_stale_desktop
PODIUM_UPDATE_TEST_AUTOCONFIRM=1 PODIUM_STATE_DIR="$BAD_STATE" APPIMAGE="$BAD_ABS" \
  timeout 90 xvfb-run -a "$BAD_APP010" >/tmp/update-corrupt.log 2>&1 || true
BAD_HASH_POST="$(sha256sum "$BAD_ABS" 2>/dev/null | cut -d' ' -f1)"
kill $BAD_FEED 2>/dev/null || true
wait $BAD_FEED 2>/dev/null || true   # reap it so :$PORT is free for ARM B's feed
trap 'restore_conf' EXIT

# Which update path did this boot take? Both arms drive the NATIVE fallback, which only
# runs when the page has not claimed ownership inside the 8 s grace — and the shipped web
# bundle DOES claim it, from the update panel's own mount. That is correct product
# behaviour and it silently turns both arms into assertions about nothing, so the shell
# writes the branch it chose into the state dir and the arm reads it (POD-2104).
BAD_PATH="$(cat "$BAD_STATE/update-ownership" 2>/dev/null || echo 'UNKNOWN')"
# Did the updater actually fetch the damaged artifact? Without that, nothing was rejected.
BAD_FETCHED=no
grep -q 'artifact request' /tmp/corrupt-feed.log 2>/dev/null && BAD_FETCHED=yes
# Assertion 1: the installer never replaced or truncated the running AppImage.
BAD_INTACT=no
[ -n "$BAD_HASH_POST" ] && [ "$BAD_HASH_PRE" = "$BAD_HASH_POST" ] && BAD_INTACT=yes
# Assertion 2: the old AppImage is still launchable and still reports 0.1.0. Fresh state
# dir, not pre-seeded — an ABSENT running-version is a detectable failure, not a pass.
kill_stale_desktop
BAD_RERUN_STATE="$(mktemp -d)"
PODIUM_STATE_DIR="$BAD_RERUN_STATE" timeout 30 xvfb-run -a "$BAD_APP010" \
  >/tmp/post-corrupt.log 2>&1 || true
BAD_RERUN_VERSION="$(cat "$BAD_RERUN_STATE/running-version" 2>/dev/null || echo 'ABSENT')"
BAD_RERUN_SETUP_RAN=no
[ -f "$BAD_RERUN_STATE/running-version" ] && [ -f "$BAD_RERUN_STATE/bin/podium-sidecar" ] \
  && BAD_RERUN_SETUP_RAN=yes

if [ "$BAD_PATH" = "page" ]; then
  FAILCLOSED_OK="INCONCLUSIVE (the page claimed update ownership, so the native path never ran)"
elif [ "$BAD_FETCHED" != "yes" ]; then
  FAILCLOSED_OK="INCONCLUSIVE (corrupt artifact was never downloaded — nothing was rejected)"
elif [ "$BAD_INTACT" = "yes" ] && [ "$BAD_RERUN_SETUP_RAN" = "yes" ] && [ "$BAD_RERUN_VERSION" = "0.1.0" ]; then
  FAILCLOSED_OK=yes
else
  FAILCLOSED_OK=no
fi
echo "=== ARM A RESULT: update path=$BAD_PATH, corrupt artifact downloaded=$BAD_FETCHED," \
     "appimage intact=$BAD_INTACT," \
     "re-run setup ran=$BAD_RERUN_SETUP_RAN, version=$BAD_RERUN_VERSION -> fail-closed: $FAILCLOSED_OK ==="
grep -iE "update|signature|install|fail" /tmp/update-corrupt.log | head -30 || true
rm -rf "$BAD_STATE" "$BAD_RERUN_STATE" "$CORRUPT_DIR"

# --- ARM B: serve the GENUINE v0.1.1 from the local signed feed -------------
bun scripts/serve-update-feed.ts "dist-verify/0.1.1" 0.1.1 "$PORT" &
FEED=$!
trap 'kill $FEED 2>/dev/null || true; restore_conf' EXIT
sleep 1
echo "=== FEED up (pid $FEED) on :$PORT ==="
# prove the manifest serves
curl -fsS "http://127.0.0.1:$PORT/updates/feed/dev/latest.json" | head -c 400; echo

echo "=== single-instance pre-flight: killing stale desktop instances ==="
kill_stale_desktop

# --- ARM B: run v0.1.0 under Xvfb; let the updater check+download+install ----
# FRESH EMPTY state dir — deliberately do NOT pre-seed running-version. If the launch
# no-ops (single-instance focus-exit, or setup() never runs), running-version is ABSENT,
# which is a DETECTABLE failure rather than a stale 0.1.0 that would mask it.
SMOKE_STATE="$(mktemp -d)"
configure_dev_feed "$SMOKE_STATE"
APP010="dist-verify/0.1.0/Podium_0.1.0_amd64.AppImage"
chmod +x "$APP010"
ABS_APP010="$(readlink -f "$APP010")"
PRE_SIZE=$(stat -c%s "$ABS_APP010")
echo "=== RUN v0.1.0 (state=$SMOKE_STATE [fresh/empty], APPIMAGE=$ABS_APP010, size=$PRE_SIZE) ==="

# APPIMAGE points the updater at the on-disk file to self-replace.
PODIUM_UPDATE_TEST_AUTOCONFIRM=1 PODIUM_STATE_DIR="$SMOKE_STATE" APPIMAGE="$ABS_APP010" \
  timeout 90 xvfb-run -a "$APP010" >/tmp/update-run.log 2>&1 || true
echo "=== RUN finished; updater-relevant log lines: ==="
grep -iE "update|version|signature|install|restart|podium" /tmp/update-run.log | head -60 || true

# --- assert each stage ------------------------------------------------------
echo "=== STAGE ASSERTIONS ==="
CHECK_OK=no; DL_OK=no; SIG_OK=no; INSTALL_OK=no; UPGRADE_OK=no

# Authoritative boot signal = the STATE DIR, not the log. Under --appimage-extract-and-run
# AppRun redirects the child's stdout, so /tmp/update-run.log is frequently EMPTY even on a
# fully successful boot. setup() writes BOTH $PODIUM_STATE_DIR/running-version and (via
# ensure_executable) $PODIUM_STATE_DIR/bin/podium-sidecar; their presence proves setup() ran
# (i.e. NOT a single-instance focus-exit no-op). Log greps are kept as best-effort diagnostics.
POST_VERSION="$(cat "$SMOKE_STATE/running-version" 2>/dev/null || echo 'ABSENT')"
# Same question as ARM A: did this boot take the native path the arm is testing, or did
# the page claim ownership and leave it testing nothing? (POD-2104)
SMOKE_PATH="$(cat "$SMOKE_STATE/update-ownership" 2>/dev/null || echo 'UNKNOWN')"
POST_SIZE=$(stat -c%s "$ABS_APP010" 2>/dev/null || echo 0)
if [ -f "$SMOKE_STATE/running-version" ] && [ -f "$SMOKE_STATE/bin/podium-sidecar" ]; then
  CHECK_OK="booted(state:$POST_VERSION)"
else
  CHECK_OK="NO-OP (running-version=$POST_VERSION, sidecar present: $([ -f "$SMOKE_STATE/bin/podium-sidecar" ] && echo yes || echo no))"
fi
# signature: no signature-verification error in the (best-effort) run log
if grep -qiE "signature.*(error|fail|invalid|mismatch)" /tmp/update-run.log 2>/dev/null; then SIG_OK=no; else SIG_OK=clean; fi
# install error? (best-effort log diagnostic)
grep -qi "update install failed" /tmp/update-run.log 2>/dev/null && INSTALL_OK=failed
echo "first-run state-dir running-version: $POST_VERSION  (appimage size $PRE_SIZE -> $POST_SIZE)"

# --- authoritative gate: re-run the (possibly replaced) on-disk AppImage ------
# Kill any lingering desktop instance again so this re-run is NOT a single-instance no-op.
echo "=== single-instance pre-flight (pre re-run) ==="
kill_stale_desktop
# FRESH state dir; do NOT pre-seed running-version. Absence => the launch no-op'd
# (detectable failure) rather than a stale value masking it.
RERUN_STATE="$(mktemp -d)"
rm -f "$RERUN_STATE/running-version"
PODIUM_STATE_DIR="$RERUN_STATE" timeout 30 xvfb-run -a "$APP010" >/tmp/post-run.log 2>&1 || true
RERUN_VERSION="$(cat "$RERUN_STATE/running-version" 2>/dev/null || echo 'ABSENT')"
RERUN_SETUP_RAN=no
[ -f "$RERUN_STATE/running-version" ] && [ -f "$RERUN_STATE/bin/podium-sidecar" ] && RERUN_SETUP_RAN=yes
echo "on-disk AppImage re-run: setup ran=$RERUN_SETUP_RAN, self-reports version: $RERUN_VERSION"

# FIX 1 — STRICT pass gate: success iff the on-disk re-run reports 0.1.1 (setup() actually ran).
# The size OR-clause is REMOVED: both AppImages are byte-identical in size, so a size change
# would mean CORRUPTION, not a successful upgrade. Size is a logged diagnostic only.
if [ "$RERUN_SETUP_RAN" = "yes" ] && [ "$RERUN_VERSION" = "0.1.1" ]; then
  UPGRADE_OK=yes
fi

echo "---- RESULT ----"
echo "ARM A corrupt artifact fails closed: $FAILCLOSED_OK"
echo "  (downloaded=$BAD_FETCHED, appimage intact=$BAD_INTACT, still boots=$BAD_RERUN_SETUP_RAN, version=$BAD_RERUN_VERSION)"
echo "ARM B first run (state-dir boot signal): $CHECK_OK"
echo "ARM B update path taken: $SMOKE_PATH  (native = the fallback these arms exercise)"
echo "signature (no error in log): $SIG_OK"
echo "install step: $INSTALL_OK"
echo "re-run setup() ran (running-version + bin/podium-sidecar present): $RERUN_SETUP_RAN"
echo "self-reported version after upgrade: $RERUN_VERSION"
echo "appimage size (diagnostic only): $PRE_SIZE -> $POST_SIZE"

RESULT_RC=0
if [ "$UPGRADE_OK" = "yes" ]; then
  echo "UPGRADE VERIFIED ✓ (v0.1.0 -> v0.1.1) — on-disk re-run boots 0.1.1"
else
  echo "UPGRADE NOT verified — on-disk re-run did not boot 0.1.1 (running-version=$RERUN_VERSION, setup ran=$RERUN_SETUP_RAN)."
  [ "$SMOKE_PATH" = "page" ] && echo "  CAUSE: the page claimed update ownership, so the native install this arm drives never ran."
  echo "  Inspect /tmp/update-run.log and /tmp/post-run.log. Note: under --appimage-extract-and-run"
  echo "  the in-place \$APPIMAGE self-replace may not occur, and AppRun may swallow stdout."
  RESULT_RC=2
fi
# A corrupted artifact that does NOT fail closed is worse than an upgrade that does not
# happen, so it gets its own exit code and overrides the ARM B verdict.
if [ "$FAILCLOSED_OK" = "yes" ]; then
  echo "FAIL-CLOSED VERIFIED ✓ — corrupted artifact rejected, v0.1.0 left intact and launchable"
else
  echo "FAIL-CLOSED NOT verified — $FAILCLOSED_OK. Inspect /tmp/update-corrupt.log,"
  echo "  /tmp/post-corrupt.log and /tmp/corrupt-feed.log."
  RESULT_RC=3
fi
rm -rf "$SMOKE_STATE" "$RERUN_STATE" "$BAD_ARM_DIR"
exit "$RESULT_RC"
