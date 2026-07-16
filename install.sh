#!/bin/sh
# Podium installer. Usage:
#   curl -fsSL .../install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --join <TOKEN> [--channel edge]
#   GH_TOKEN=<token> curl -fsSL -H "Authorization: Bearer $GH_TOKEN" .../install.sh | GH_TOKEN=$GH_TOKEN sh -s -- --channel edge
set -eu

REPO="madeinorbit/podium"
CHANNEL="stable"
JOIN=""
AUTO_UPDATE="1"
# Ed25519 pubkey (SPKI/DER, base64). Commit the SAME value as PODIUM_UPDATE_PUBKEY in
# apps/cli/src/podium-update-pubkey.ts — the lockstep test in Step 5 enforces they match. (A test
# override is allowed via PODIUM_INSTALL_PUBKEY.) The key is public; committing it is safe.
PUBKEY="${PODIUM_INSTALL_PUBKEY:-MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU=}"
GITHUB_AUTH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

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
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$GITHUB_AUTH_TOKEN" ]; then
      CURL_AUTH_CONFIG="$TMP/curl-auth.conf"
      if [ ! -f "$CURL_AUTH_CONFIG" ]; then
        ( umask 077
          printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_AUTH_TOKEN"
          printf 'header = "Accept: application/octet-stream"\n'
        ) > "$CURL_AUTH_CONFIG"
      fi
      curl -fsSL --config "$CURL_AUTH_CONFIG" "$1" -o "$2"
    else
      curl -fsSL "$1" -o "$2"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "$GITHUB_AUTH_TOKEN" ]; then
      echo "podium: authenticated GitHub downloads require curl" >&2
      exit 1
    fi
    wget -qO "$2" "$1"
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
if ! "$BIN/podium" channel "$CHANNEL" >/dev/null; then
  echo "podium: installed, but could not persist update channel '$CHANNEL'; run: podium channel $CHANNEL" >&2
fi
echo "Installed to $DEST"

# --- PATH hint ---
case ":$PATH:" in *":$BIN:"*) : ;; *) echo "Note: add $BIN to your PATH." ;; esac

if [ -z "$JOIN" ]; then
  echo "Done. Run: podium"
  exit 0
fi

# --- join mode: delegate to the CLI so config + unit text have ONE source of truth
#     (`podium setup --join` runs the same engine as interactive setup and renders the
#     daemon unit via renderDaemonUnit — issue #20). Non-interactive; safe piped. ---
JOIN_FALLBACK=""
if ! "$BIN/podium" setup --join "$JOIN" --persist systemd; then
  echo "podium: automated join failed; falling back to manual unit install" >&2
  JOIN_FALLBACK=1
  "$BIN/podium" join-config "$JOIN"
fi
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$UNIT_DIR"
if [ -n "$JOIN_FALLBACK" ]; then
  # Fallback unit — GENERATED from renderDaemonUnit() in apps/cli/src/cli-systemd.ts (the
  # single source; regenerate with `bun scripts/render-systemd.ts`). Do not hand-edit: the
  # lockstep test in apps/cli/src/cli-systemd.test.ts and `render-systemd.ts --check` (part
  # of `bun run lint`) both fail on drift.
  cat > "$UNIT_DIR/podium-daemon.service" <<'EOF'
[Unit]
Description=Podium per-machine agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PATH=%h/.local/bin:%h/.bun/bin:%h/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
ExecStart=%h/.local/bin/podium daemon
Restart=always
RestartSec=2
# The daemon exits 78 when the server TERMINALLY rejected it (pairRejected/helloRejected):
# restarting would just re-hammer the same rejected handshake, so don't (issue #19).
# `podium status` explains the blocked state and how to re-pair.
RestartPreventExitStatus=78
# Two-tier scheduling (POD-598): hosts run heavily CPU-oversubscribed by agent/test
# workloads; POD-594 measured this daemon's main thread runqueue-waiting 60% of wall
# time with everything at default CPUWeight=100. Interactive Podium services get the
# high tier; per-agent scopes get CPUWeight=50/IOWeight=100 (agent-bridge).
CPUWeight=900
IOWeight=500
MemoryLow=2G

[Install]
WantedBy=default.target
EOF
fi
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
  # The delegated `podium setup --join` already enabled+started the daemon unit; only the
  # fallback path needs to do it here.
  if [ -n "$JOIN_FALLBACK" ]; then
    systemctl --user enable --now podium-daemon || \
      echo "Could not start the user service automatically; run: systemctl --user enable --now podium-daemon"
  fi
  if [ -n "$AUTO_UPDATE" ]; then
    systemctl --user enable --now podium-update-user.timer || \
      echo "Could not enable auto-update; run: systemctl --user enable --now podium-update-user.timer"
  fi
else
  echo "No systemd here. Start the daemon with: podium daemon"
fi
echo "Joined."
