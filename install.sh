#!/bin/sh
# Podium installer. Usage:
#   curl -fsSL .../install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --join <TOKEN> [--channel edge]
set -eu

REPO="madeinorbit/podium"
CHANNEL="stable"
JOIN=""
AUTO_UPDATE="1"
# Ed25519 pubkey (SPKI/DER, base64). Commit the SAME value as PODIUM_UPDATE_PUBKEY in
# scripts/podium-update-pubkey.ts — the lockstep test in Step 5 enforces they match. (A test
# override is allowed via PODIUM_INSTALL_PUBKEY.) The key is public; committing it is safe.
PUBKEY="${PODIUM_INSTALL_PUBKEY:-MCowBQYDK2VwAyEAvToQHbEK4FSYyY0OJEyacn+zp5r8n5QEE+Y2OIL+onY=}"

while [ $# -gt 0 ]; do
  case "$1" in
    --join) JOIN="${2:?--join requires a TOKEN}"; shift 2 ;;
    --channel) CHANNEL="${2:?--channel requires a value}"; shift 2 ;;
    --no-auto-update) AUTO_UPDATE=""; shift ;;
    *) echo "podium install: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# --- platform detection (linux-x64 only for now) ---
OS="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OS" != "Linux" ] || { [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; }; then
  echo "podium: unsupported platform $OS/$ARCH (linux-x64 only for now; build from source)" >&2
  exit 1
fi
ASSET="podium-headless-linux-x64.tar.gz"

# --- resolve download base ---
if [ -n "${PODIUM_INSTALL_BASE:-}" ]; then
  BASE="$PODIUM_INSTALL_BASE"                                   # tests / mirrors
elif [ "$CHANNEL" = "edge" ]; then
  BASE="https://github.com/$REPO/releases/download/edge"
else
  BASE="https://github.com/$REPO/releases/latest/download"
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fetch() { # fetch <url> <out>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "podium: need curl or wget" >&2; exit 1; fi
}
echo "Downloading $ASSET ($CHANNEL)…"
fetch "$BASE/$ASSET" "$TMP/$ASSET"
fetch "$BASE/$ASSET.sig" "$TMP/$ASSET.sig"

# --- verify Ed25519 signature (fail closed) ---
echo "$PUBKEY" | base64 -d > "$TMP/pub.der"
base64 -d "$TMP/$ASSET.sig" > "$TMP/$ASSET.sig.raw"
if ! openssl pkeyutl -verify -pubin -inkey "$TMP/pub.der" -keyform DER -rawin \
       -in "$TMP/$ASSET" -sigfile "$TMP/$ASSET.sig.raw" >/dev/null 2>&1; then
  echo "podium: signature verification FAILED — refusing to install. Nothing was written." >&2
  exit 1
fi

# --- install: extract to a temp dir on the target filesystem, then atomic rename ---
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/podium"
BIN="$HOME/.local/bin"; mkdir -p "$BIN" "$(dirname "$DEST")"
STAGE="$(dirname "$DEST")/.podium-install.$$"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$TMP/$ASSET" -C "$STAGE"
[ -d "$STAGE/headless" ] || { echo "podium: tarball missing headless/ dir" >&2; rm -rf "$STAGE"; exit 1; }
rm -rf "$DEST"; mv "$STAGE/headless" "$DEST"; rm -rf "$STAGE"
ln -sf "$DEST/podium" "$BIN/podium"
echo "Installed to $DEST"

# --- PATH hint ---
case ":$PATH:" in *":$BIN:"*) : ;; *) echo "Note: add $BIN to your PATH." ;; esac

if [ -z "$JOIN" ]; then
  echo "Done. Run: podium"
  exit 0
fi

# --- join mode: configure + enable the daemon ---
"$BIN/podium" join-config "$JOIN"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/podium-daemon.service" <<EOF
[Unit]
Description=Podium agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
ExecStart=%h/.local/bin/podium daemon
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
# --- auto-update timer: `podium update` on a daily cadence, restart the daemon only when it
#     actually swapped in a new bundle (exit 10). Opt out with --no-auto-update. ---
if [ -n "$AUTO_UPDATE" ]; then
  cat > "$UNIT_DIR/podium-update-user.service" <<EOF
[Unit]
Description=Podium headless self-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env sh -c '%h/.local/bin/podium update; ec=\$?; [ "\$ec" = 10 ] && systemctl --user try-restart podium-daemon.service; exit 0'
EOF
  cat > "$UNIT_DIR/podium-update-user.timer" <<EOF
[Unit]
Description=Podium headless self-update (daily)

[Timer]
OnCalendar=daily
Persistent=true
Unit=podium-update-user.service

[Install]
WantedBy=default.target
EOF
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
  systemctl --user enable --now podium-daemon || \
    echo "Could not start the user service automatically; run: systemctl --user enable --now podium-daemon"
  if [ -n "$AUTO_UPDATE" ]; then
    systemctl --user enable --now podium-update-user.timer || \
      echo "Could not enable auto-update; run: systemctl --user enable --now podium-update-user.timer"
  fi
else
  echo "No systemd here. Start the daemon with: podium daemon"
fi
echo "Joined."
