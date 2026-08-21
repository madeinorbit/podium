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
SIDECAR="$APP/Contents/Resources/resources/payload/podium-cli"

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

echo "== Application Support seed execution =="
# Copying out of the signed frame is the actual first-run boundary. Exercise the same
# quarantine removal the shell performs, then ask Gatekeeper and the launcher to execute
# the external bytes rather than inferring success from the in-bundle signature.
seed_work="$(mktemp -d)"
seeded="$seed_work/payload"
cp -R "$APP/Contents/Resources/resources/payload" "$seeded"
xattr -w com.apple.quarantine '0081;00000000;Podium;' "$seeded/podium-cli"
xattr -dr com.apple.quarantine "$seeded"
if xattr -p com.apple.quarantine "$seeded/podium-cli" >/dev/null 2>&1; then
  fail "seeded payload still carries com.apple.quarantine"
fi
codesign --verify --strict --verbose=2 "$seeded/podium-cli" \
  || fail "seeded external podium-cli signature invalid"
"$seeded/podium-cli" --version >/dev/null \
  || fail "seeded external podium-cli did not launch"
rm -rf "$seed_work"

echo "== fleet grant payload execution =="
# stage-sidecar built the feed tarball before its copy was Developer-ID re-signed
# inside the app. These are therefore the exact ad-hoc-signed bytes an ordinary
# fleet grant installs, not another copy of the seed checked above.
grant_tarball="$(find dist-bun -maxdepth 1 -name 'podium-headless-*.tar.gz' -print -quit)"
[ -f "$grant_tarball" ] || fail "no headless grant tarball in dist-bun"
grant_work="$(mktemp -d)"
tar -xzf "$grant_tarball" -C "$grant_work"
granted="$grant_work/headless"
[ -x "$granted/podium-cli" ] || fail "grant tarball has no executable podium-cli"
xattr -w com.apple.quarantine "0081;00000000;Podium;" "$granted/podium-cli"
xattr -dr com.apple.quarantine "$granted"
if xattr -p com.apple.quarantine "$granted/podium-cli" >/dev/null 2>&1; then
  fail "grant-delivered payload still carries com.apple.quarantine"
fi
codesign --verify --strict --verbose=2 "$granted/podium-cli" \
  || fail "grant-delivered podium-cli signature invalid"
codesign -d --entitlements - --xml "$granted/podium-cli" 2>/dev/null | grep -q 'allow-jit' \
  || fail "grant-delivered podium-cli is missing the JIT entitlement"
"$granted/podium" --version >/dev/null \
  || fail "grant-delivered payload launcher did not run"
rm -rf "$grant_work"

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
