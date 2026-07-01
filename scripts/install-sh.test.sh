#!/usr/bin/env bash
# scripts/install-sh.test.sh — runs install.sh against a local fixture "release".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"
export PODIUM_STATE_DIR="$HOME/.podium"

# --- build a fake signed release into $WORK/release ---
REL="$WORK/release"; mkdir -p "$REL/headless"
printf '#!/bin/sh\necho podium-stub "$@"\n' > "$REL/headless/podium"; chmod +x "$REL/headless/podium"
echo "9.9.9" > "$REL/headless/VERSION"
( cd "$REL" && tar -czf podium-headless-linux-x64.tar.gz headless )
# sign with a throwaway ed25519 key; write its pubkey where install.sh expects an override
openssl genpkey -algorithm ed25519 -out "$WORK/priv.pem" 2>/dev/null
openssl pkey -in "$WORK/priv.pem" -pubout -outform DER 2>/dev/null | base64 -w0 > "$WORK/pub.b64"
openssl pkeyutl -sign -inkey "$WORK/priv.pem" -rawin \
  -in "$REL/podium-headless-linux-x64.tar.gz" -out "$REL/podium-headless-linux-x64.tar.gz.sig.raw"
base64 -w0 "$REL/podium-headless-linux-x64.tar.gz.sig.raw" > "$REL/podium-headless-linux-x64.tar.gz.sig"

# install.sh reads PODIUM_INSTALL_BASE (file:// or http) + PODIUM_INSTALL_PUBKEY (override) for tests.
export PODIUM_INSTALL_BASE="file://$REL"
export PODIUM_INSTALL_PUBKEY="$(cat "$WORK/pub.b64")"

echo "== plain install =="
sh "$ROOT/install.sh"
test -x "$HOME/.local/bin/podium"            || { echo FAIL: no launcher symlink; exit 1; }
test -f "$HOME/.local/share/podium/VERSION"  || { echo FAIL: bundle not installed; exit 1; }

# Stub systemctl + loginctl so --join runs write the unit FILES without touching the real
# user session; we assert on the written files, not on systemctl succeeding.
STUB="$WORK/bin"; mkdir -p "$STUB"
printf '#!/bin/sh\nexit 0\n' > "$STUB/systemctl"; chmod +x "$STUB/systemctl"
printf '#!/bin/sh\nexit 0\n' > "$STUB/loginctl"; chmod +x "$STUB/loginctl"
export PATH="$STUB:$PATH"
UNIT="$HOME/.config/systemd/user"

echo "== join enables the auto-update timer =="
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$HOME/.config/systemd"
sh "$ROOT/install.sh" --join TESTTOKEN
test -f "$UNIT/podium-daemon.service"       || { echo FAIL: join did not write daemon unit; exit 1; }
test -f "$UNIT/podium-update-user.service"  || { echo FAIL: join did not write update service; exit 1; }
test -f "$UNIT/podium-update-user.timer"    || { echo FAIL: join did not write update timer; exit 1; }

echo "== --no-auto-update skips the timer =="
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$HOME/.config/systemd"
sh "$ROOT/install.sh" --join TESTTOKEN --no-auto-update
test -f "$UNIT/podium-daemon.service"       || { echo FAIL: join did not write daemon unit; exit 1; }
test ! -e "$UNIT/podium-update-user.timer"  || { echo "FAIL: --no-auto-update wrote the timer anyway"; exit 1; }
test ! -e "$UNIT/podium-update-user.service" || { echo "FAIL: --no-auto-update wrote the update service anyway"; exit 1; }

echo "== tamper rejection =="
printf 'x' >> "$REL/podium-headless-linux-x64.tar.gz"   # corrupt after signing
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium"
if sh "$ROOT/install.sh" 2>/dev/null; then echo "FAIL: tampered install succeeded"; exit 1; fi
test ! -e "$HOME/.local/share/podium" || { echo FAIL: wrote bundle despite bad sig; exit 1; }

echo "ALL OK"
