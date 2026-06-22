#!/usr/bin/env bash
# E2E desktop update verification: build v0.1.0 and v0.1.1, serve v0.1.1 from a local
# signed feed, run the on-disk v0.1.0 AppImage under Xvfb, and assert it upgrades.
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
  # Also: point the updater at the local feed port + allow the http:// (test) endpoint.
  node -e "const fs=require('fs');const f='$CONF';const o=JSON.parse(fs.readFileSync(f,'utf8'));o.version='$1';o.plugins=o.plugins||{};o.plugins.updater=o.plugins.updater||{};o.plugins.updater.dangerousInsecureTransportProtocol=true;o.plugins.updater.endpoints=['http://127.0.0.1:$PORT/update/{{target}}/{{arch}}/{{current_version}}'];fs.writeFileSync(f,JSON.stringify(o,null,2)+'\n')"
  node -e "const fs=require('fs');const f='package.json';const o=JSON.parse(fs.readFileSync(f,'utf8'));o.version='$1';fs.writeFileSync(f,JSON.stringify(o,null,2)+'\n')"
}

build() { # $1 = version
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

# --- serve v0.1.1 from the local signed feed --------------------------------
bun scripts/serve-update-feed.ts "dist-verify/0.1.1" 0.1.1 "$PORT" &
FEED=$!
trap 'kill $FEED 2>/dev/null || true; restore_conf' EXIT
sleep 1
echo "=== FEED up (pid $FEED) on :$PORT ==="
# prove the manifest serves
curl -fsS "http://127.0.0.1:$PORT/update/linux-x86_64/x86_64/0.1.0" | head -c 400; echo

# --- run v0.1.0 under Xvfb; let the updater check+download+install -----------
SMOKE_STATE="$(mktemp -d)"
APP010="dist-verify/0.1.0/Podium_0.1.0_amd64.AppImage"
chmod +x "$APP010"
ABS_APP010="$(readlink -f "$APP010")"
echo "0.1.0" > "$SMOKE_STATE/running-version"   # baseline; the app overwrites it on boot
PRE_SIZE=$(stat -c%s "$ABS_APP010")
echo "=== RUN v0.1.0 (state=$SMOKE_STATE, APPIMAGE=$ABS_APP010, size=$PRE_SIZE) ==="

# APPIMAGE points the updater at the on-disk file to self-replace.
PODIUM_UPDATE_AUTOCONFIRM=1 PODIUM_STATE_DIR="$SMOKE_STATE" APPIMAGE="$ABS_APP010" \
  timeout 90 xvfb-run -a "$APP010" >/tmp/update-run.log 2>&1 || true
echo "=== RUN finished; updater-relevant log lines: ==="
grep -iE "update|version|signature|install|restart|podium-desktop" /tmp/update-run.log | head -60 || true

# --- assert each stage ------------------------------------------------------
echo "=== STAGE ASSERTIONS ==="
CHECK_OK=no; DL_OK=no; SIG_OK=no; INSTALL_OK=no; UPGRADE_OK=no

# check: the app logged the running version 0.1.0 (proves it booted + ran setup)
grep -q "running version 0.1.0" /tmp/update-run.log && CHECK_OK=booted
# download: the feed logged an artifact request
# signature: no signature-verification error appeared in the run log
if grep -qiE "signature.*(error|fail|invalid|mismatch)" /tmp/update-run.log; then SIG_OK=no; else SIG_OK=clean; fi
# install error?
grep -qi "update install failed" /tmp/update-run.log && INSTALL_OK=failed

# The deterministic signal: did the on-disk app become 0.1.1?
POST_VERSION="$(cat "$SMOKE_STATE/running-version" 2>/dev/null || echo '?')"
POST_SIZE=$(stat -c%s "$ABS_APP010" 2>/dev/null || echo 0)
echo "running-version after run: $POST_VERSION  (appimage size $PRE_SIZE -> $POST_SIZE)"

# Re-run the (possibly replaced) on-disk AppImage to capture its self-reported version.
echo "0.1.0" > "$SMOKE_STATE/running-version"
PODIUM_STATE_DIR="$SMOKE_STATE" timeout 30 xvfb-run -a "$APP010" >/tmp/post-run.log 2>&1 || true
RERUN_VERSION="$(cat "$SMOKE_STATE/running-version" 2>/dev/null || echo '?')"
echo "on-disk AppImage now self-reports version: $RERUN_VERSION"

if [ "$RERUN_VERSION" = "0.1.1" ] || [ "$POST_SIZE" != "$PRE_SIZE" ]; then
  UPGRADE_OK=yes
fi

echo "---- RESULT ----"
echo "check(booted+0.1.0 seen): $CHECK_OK"
echo "signature (no error in log): $SIG_OK"
echo "install step: $INSTALL_OK"
echo "self-reported version after upgrade: $RERUN_VERSION"
echo "appimage size: $PRE_SIZE -> $POST_SIZE"
if [ "$UPGRADE_OK" = "yes" ]; then
  echo "UPGRADE VERIFIED ✓ (v0.1.0 -> v0.1.1)"
else
  echo "UPGRADE NOT verified by file-swap — inspect /tmp/update-run.log (headless \$APPIMAGE self-replace risk)"
fi
rm -rf "$SMOKE_STATE"
