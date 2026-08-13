#!/usr/bin/env bash
#
# Prove a built macOS bundle is actually Developer ID signed, hardened, notarized, and stapled.
#
# This exists because every one of those four can fail SILENTLY: `tauri build` happily emits an
# ad-hoc bundle when the identity is missing, and notarization that never ran leaves an app that
# installs fine on the build machine and is refused on a user's. Run it in CI between build and
# publish so a broken release fails before it is uploaded, not after someone downloads it.
#
# Usage: verify-macos-signing.sh <bundle-dir>
#   bundle-dir defaults to the aarch64 release bundle dir.
set -euo pipefail

BUNDLE_DIR="${1:-apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle}"
APP="$BUNDLE_DIR/macos/Podium.app"
SIDECAR="$APP/Contents/Resources/resources/podium"

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -d "$APP" ] || fail "no app bundle at $APP"
[ -f "$SIDECAR" ] || fail "no bundled sidecar at $SIDECAR"

echo "== app signature =="
# --deep --strict walks nested code; without it an unsigned sidecar passes here and fails at Apple.
codesign --verify --deep --strict --verbose=2 "$APP" || fail "app signature invalid"

# An ad-hoc signature has no Authority line. Requiring "Developer ID Application" is what catches a
# release built with a missing or misspelled APPLE_SIGNING_IDENTITY.
codesign -dvvv "$APP" 2>&1 | grep -q 'Authority=Developer ID Application' \
  || fail "app is not signed with a Developer ID Application certificate"
codesign -dvvv "$APP" 2>&1 | grep -q 'flags=.*runtime' \
  || fail "app is not signed with the hardened runtime (notarization would reject it)"

echo "== sidecar signature =="
codesign --verify --strict --verbose=2 "$SIDECAR" || fail "sidecar signature invalid"
codesign -dvvv "$SIDECAR" 2>&1 | grep -q 'Authority=Developer ID Application' \
  || fail "bundled podium sidecar is not Developer ID signed"
codesign -d --entitlements - --xml "$SIDECAR" 2>/dev/null | grep -q 'allow-jit' \
  || fail "sidecar is missing the JIT entitlement — a Bun binary will not start under the hardened runtime"

echo "== notarization =="
# stapler validate is the offline proof: it reads the ticket stapled INTO the bundle. It is the
# only check here that a machine with no network still honors.
xcrun stapler validate "$APP" || fail "app has no stapled notarization ticket"
spctl --assess --type exec -vvv "$APP" 2>&1 | tee /dev/stderr | grep -q 'source=Notarized Developer ID' \
  || fail "Gatekeeper does not see this app as notarized"

for dmg in "$BUNDLE_DIR"/dmg/*.dmg; do
  [ -e "$dmg" ] || continue
  echo "== dmg: $(basename "$dmg") =="
  xcrun stapler validate "$dmg" || fail "$dmg has no stapled notarization ticket"
done

# The updater installs from this tarball rather than the DMG, so a ticket missing HERE produces
# apps that are fine on first install and refused after their first auto-update.
for tarball in "$BUNDLE_DIR"/macos/*.app.tar.gz; do
  [ -e "$tarball" ] || continue
  echo "== updater bundle: $(basename "$tarball") =="
  workdir="$(mktemp -d)"
  tar -xzf "$tarball" -C "$workdir"
  extracted="$(find "$workdir" -maxdepth 1 -name '*.app' -print -quit)"
  [ -n "$extracted" ] || fail "$tarball contains no .app"
  xcrun stapler validate "$extracted" || fail "the .app inside $tarball is not stapled"
  rm -rf "$workdir"
done

echo
echo "OK: Developer ID signed, hardened, notarized, and stapled."
