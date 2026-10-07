#!/bin/zsh
# Provisions the macOS/iOS runner image. Invoked by runner.pkr.hcl; safe to
# re-run by hand inside a VM. Installs nothing personal and leaves no identity.
set -euo pipefail
setopt NULL_GLOB

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

: "${XCODE_VERSION:=26.6}"
: "${IOS_RUNTIME:=iOS}"
: "${SIMULATOR_NAME:=Podium Agent}"
: "${SIMULATOR_DEVICE:=com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro}"
: "${XCODE_XIP:=}"

log() { print -r -- "==> $*"; }

log "Generic tooling"
# Homebrew 7 refuses third-party taps until trusted; temurin is a cask in core.
brew install git node tailscale
brew install --cask temurin@17
curl -fsSL https://bun.sh/install | bash

log "Maestro"
curl -Ls https://get.maestro.mobile.dev | bash
# Maestro's XCUITest driver needs far longer than its default to come up inside
# a VM, and it fails with a bare stack trace rather than a useful message.
grep -q MAESTRO_DRIVER_STARTUP_TIMEOUT ~/.zshrc 2>/dev/null \
  || echo 'export MAESTRO_DRIVER_STARTUP_TIMEOUT=600000' >> ~/.zshrc
export MAESTRO_DRIVER_STARTUP_TIMEOUT=600000

log "xcodes CLI"
# NOT via Homebrew: that formula builds from source and needs full Xcode's
# XCBuild, which is exactly what we do not have yet. Use the release binary.
XCODES_TAG=$(curl -fsSL https://api.github.com/repos/XcodesOrg/xcodes/releases/latest \
             | sed -n 's/.*"tag_name": "\([^"]*\)".*/\1/p' | head -1)
workdir=$(mktemp -d)
curl -fsSL -o "$workdir/xcodes.zip" \
  "https://github.com/XcodesOrg/xcodes/releases/download/${XCODES_TAG}/xcodes.zip"
unzip -qo "$workdir/xcodes.zip" -d "$workdir"
sudo install -m 0755 "$workdir/xcodes" /usr/local/bin/xcodes
rm -rf "$workdir"
xcodes version

log "Xcode ${XCODE_VERSION}"
if [[ -n "$XCODE_XIP" && -f "$XCODE_XIP" ]]; then
  xcodes install --path "$XCODE_XIP" --experimental-unxip
  rm -f "$XCODE_XIP"
else
  # Interactive: prompts for an Apple ID + MFA. Over SSH the keychain refuses to
  # persist the credential (OSStatus -25308), so nothing is stored -- but the
  # final privileged step also fails for the same reason and is redone below.
  xcodes install "$XCODE_VERSION" --experimental-unxip || true
fi

XCODE_APP=(/Applications/Xcode*.app)
if (( ${#XCODE_APP} == 0 )); then
  print -u2 "Xcode was not installed; aborting."
  exit 1
fi
log "Using ${XCODE_APP[1]}"
sudo xcode-select -s "${XCODE_APP[1]}/Contents/Developer"
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcodebuild -version

log "Simulator runtime (${IOS_RUNTIME} only)"
sudo xcodebuild -downloadPlatform "$IOS_RUNTIME"

log "Simulator '${SIMULATOR_NAME}'"
RUNTIME_ID=$(xcrun simctl list runtimes -j \
  | python3 -c 'import json,sys; rs=[r for r in json.load(sys.stdin)["runtimes"] if r["isAvailable"]]; print(rs[0]["identifier"])')
xcrun simctl create "$SIMULATOR_NAME" "$SIMULATOR_DEVICE" "$RUNTIME_ID"
# Xcode seeds a full default device set; keep only ours.
xcrun simctl list devices -j | SIM_KEEP="$SIMULATOR_NAME" python3 -c "
import json, os, sys, subprocess
keep = os.environ['SIM_KEEP']
for _, devs in json.load(sys.stdin)['devices'].items():
    for d in devs:
        if d['name'] != keep:
            subprocess.run(['xcrun', 'simctl', 'delete', d['udid']])
"
xcrun simctl list devices

log "Tailscale daemon (left logged OUT on purpose)"
sudo tailscaled install-system-daemon

log "Scrub"
xcodes signout 2>/dev/null || true
for s in idmsa.apple.com appleid.apple.com developer.apple.com xcodes; do
  security delete-internet-password -s "$s" 2>/dev/null || true
  security delete-generic-password  -s "$s" 2>/dev/null || true
done
rm -rf ~/.xcodes ~/Library/Cookies ~/Library/HTTPStorages \
       ~/Library/Caches/com.robotsandpencils.xcodes ~/Library/Caches/com.xcodesorg.xcodes
sudo rm -rf ~/Library/Caches/com.apple.akd
defaults delete com.apple.dt.Xcode DVTDeveloperAccountManager 2>/dev/null || true
rm -rf ~/.maestro/tests ~/.Trash/*
find ~/Library/Caches/Homebrew -maxdepth 1 -name 'xcodes--*' -exec rm -rf {} + 2>/dev/null || true
brew cleanup --prune=all || true
sudo rm -rf /Library/Tailscale/profile-data /Library/Tailscale/files \
            /Library/Tailscale/tailscaled.state /Library/Tailscale/derpmap.cached.json
: > ~/.zsh_history; : > ~/.bash_history; rm -f ~/.ssh/known_hosts

log "Done. Image carries no Apple account, no Tailscale login, no repo checkout."
