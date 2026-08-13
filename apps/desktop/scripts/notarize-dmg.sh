#!/usr/bin/env bash
#
# Sign, notarize, and staple the DMG.
#
# Tauri notarizes and staples the .app, then builds the DMG *around* the stapled app — the disk
# image itself is never submitted. That is not enough: the DMG is what a browser downloads and
# what carries the quarantine flag, so an un-notarized one shows "Apple cannot check it for
# malicious software" on the very first double-click, which is the warning this whole setup exists
# to remove. The app inside being notarized does not spare the user that dialog.
#
# Stapling matters beyond the first launch too: a stapled ticket is read offline, so the DMG keeps
# verifying on a machine with no network and after the notarization service is unreachable.
#
# Usage: notarize-dmg.sh <bundle-dir>
# Requires: APPLE_SIGNING_IDENTITY, APPLE_API_KEY_PATH, APPLE_API_KEY, APPLE_API_ISSUER
set -euo pipefail

BUNDLE_DIR="${1:-apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle}"

: "${APPLE_SIGNING_IDENTITY:?notarize-dmg.sh needs APPLE_SIGNING_IDENTITY}"
: "${APPLE_API_KEY_PATH:?notarize-dmg.sh needs APPLE_API_KEY_PATH}"
: "${APPLE_API_KEY:?notarize-dmg.sh needs APPLE_API_KEY}"
: "${APPLE_API_ISSUER:?notarize-dmg.sh needs APPLE_API_ISSUER}"

shopt -s nullglob
dmgs=("$BUNDLE_DIR"/dmg/*.dmg)
if [ ${#dmgs[@]} -eq 0 ]; then
  echo "no DMG found under $BUNDLE_DIR/dmg" >&2
  exit 1
fi

for dmg in "${dmgs[@]}"; do
  echo "== $(basename "$dmg") =="

  # Apple's guidance for disk-image distribution: sign the image, then notarize it. A signed image
  # also means the download is tamper-evident before it is ever mounted.
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"

  # --wait blocks until Apple returns a verdict. Without it the staple below races the service and
  # fails intermittently, which is worse than waiting the ~30s a submission takes.
  xcrun notarytool submit "$dmg" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY" \
    --issuer "$APPLE_API_ISSUER" \
    --wait

  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
done

echo "OK: DMG signed, notarized, and stapled."
