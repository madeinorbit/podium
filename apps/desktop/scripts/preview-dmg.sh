#!/usr/bin/env bash
#
# Build the install DMG's Finder window on this Mac in seconds, without building the app.
#
# A release DMG takes a full signed CI run to see, and the window can only be judged in a real
# Finder: it draws the icon labels itself, its title bar height depends on the macOS version, and
# the viewer's own View settings (path bar, status bar, filename extensions) change what shows.
# This runs Tauri's own bundle_dmg script, at the version our @tauri-apps/cli pins, with the same
# arguments `tauri build` passes and the committed background and layout from tauri.conf.json.
# The app inside is a stand-in carrying the real icon, unless PODIUM_APP points at a real one.
#
# Usage (macOS, from anywhere in the checkout):
#   bash apps/desktop/scripts/preview-dmg.sh
#   PODIUM_APP=/Applications/Podium.app bash apps/desktop/scripts/preview-dmg.sh
#
# After changing the art: `bun apps/desktop/scripts/generate-dmg-background.ts`, then re-run this.
set -euo pipefail

[ "$(uname)" = Darwin ] || { echo "preview-dmg.sh needs macOS (Finder writes the layout)" >&2; exit 1; }
# The layout is written by an AppleScript that drives the logged-in user's Finder; as root it
# cannot reach that Finder, and nothing here needs root.
[ "$(id -u)" != 0 ] || { echo "run preview-dmg.sh without sudo" >&2; exit 1; }

TAURI="$(cd "$(dirname "$0")/../src-tauri" && pwd)"
REPO="$(cd "$TAURI/../../.." && pwd)"
CONF="$TAURI/tauri.conf.json"
conf() { plutil -extract "$1" raw -o - "$CONF"; }

# bundle_dmg ships inside the Tauri CLI binary; fetch the same file from the matching CLI tag.
CLI_VERSION="$(grep -o '"@tauri-apps/cli@[0-9.]*"' "$REPO/bun.lock" | head -1 | tr -d '"' | sed 's/.*@//')"
[ -n "$CLI_VERSION" ] || { echo "could not read the @tauri-apps/cli version from bun.lock" >&2; exit 1; }
SRC="https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v$CLI_VERSION/crates/tauri-bundler/src/bundle/macos/dmg"

PRODUCT="$(conf productName)"
WORK="$(mktemp -d -t podium-dmg-preview)"
# Same directory shape `tauri build` uses: the script finds its AppleScript template at
# ../share/create-dmg/support relative to itself, and runs from the folder holding the .app.
mkdir -p "$WORK/dmg" "$WORK/share/create-dmg/support" "$WORK/macos"
curl -fsSL "$SRC/bundle_dmg" -o "$WORK/dmg/bundle_dmg.sh"
curl -fsSL "$SRC/template.applescript" -o "$WORK/share/create-dmg/support/template.applescript"
chmod +x "$WORK/dmg/bundle_dmg.sh"

APP="$WORK/macos/$PRODUCT.app"
if [ -n "${PODIUM_APP:-}" ]; then
  cp -R "$PODIUM_APP" "$APP"
else
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$TAURI/icons/icon.icns" "$APP/Contents/Resources/icon.icns"
  printf '#!/bin/sh\nexit 0\n' > "$APP/Contents/MacOS/$PRODUCT"
  chmod +x "$APP/Contents/MacOS/$PRODUCT"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>$PRODUCT</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>app.podium.dmg-preview</string>
  <key>CFBundleName</key><string>$PRODUCT</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
fi

args=(
  --volname "$PRODUCT"
  --icon "$PRODUCT.app" "$(conf bundle.macOS.dmg.appPosition.x)" "$(conf bundle.macOS.dmg.appPosition.y)"
  --app-drop-link "$(conf bundle.macOS.dmg.applicationFolderPosition.x)" "$(conf bundle.macOS.dmg.applicationFolderPosition.y)"
  --window-size "$(conf bundle.macOS.dmg.windowSize.width)" "$(conf bundle.macOS.dmg.windowSize.height)"
  --hide-extension "$PRODUCT.app"
  --background "$TAURI/$(conf bundle.macOS.dmg.background)"
  --volicon "$TAURI/icons/icon.icns"
)
if pos_x="$(conf bundle.macOS.dmg.windowPosition.x 2>/dev/null)"; then
  args+=(--window-pos "$pos_x" "$(conf bundle.macOS.dmg.windowPosition.y)")
fi

# hdiutil stages the image as /Volumes/<volname>. A Podium DMG that is already mounted there (a
# release you opened, or an earlier preview) makes it copy into that read-only volume instead and
# fail with "Operation not permitted", so unmount every one first and stop if one will not go.
for vol in "/Volumes/$PRODUCT" "/Volumes/$PRODUCT "[0-9]*; do
  [ -d "$vol" ] || continue
  hdiutil detach "$vol" -quiet 2>/dev/null || hdiutil detach "$vol" -force -quiet 2>/dev/null || true
  if [ -d "$vol" ]; then
    echo "$vol is still mounted: close Podium if it runs from there, eject it in Finder, retry" >&2
    exit 1
  fi
done
(cd "$WORK/macos" && "$WORK/dmg/bundle_dmg.sh" "${args[@]}" "$PRODUCT.dmg" "$PRODUCT.app")

open "$WORK/macos/$PRODUCT.dmg"
echo "Opened $WORK/macos/$PRODUCT.dmg (Tauri bundle_dmg from CLI $CLI_VERSION)."
