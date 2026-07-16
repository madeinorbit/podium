#!/bin/sh
# Podium installer. Usage:
#   curl -fsSL .../install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --instance <ID>
#   curl -fsSL .../install.sh | sh -s -- --join <TOKEN> [--channel edge]
#   GH_TOKEN=<token> curl -fsSL -H "Authorization: Bearer $GH_TOKEN" .../install.sh | GH_TOKEN=$GH_TOKEN sh -s -- --channel edge
set -eu

REPO="madeinorbit/podium"
CHANNEL="stable"
JOIN=""
AUTO_UPDATE="1"
INSTANCE="default"
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
    --instance) INSTANCE="${2:?--instance requires an ID}"; shift 2 ;;
    --instance=*) INSTANCE="${1#--instance=}"; shift ;;
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

case "$INSTANCE" in
  ""|[!a-z]*|*[!a-z0-9-]*)
    echo "podium install: invalid instance id '$INSTANCE' (use [a-z][a-z0-9-]{0,31})" >&2; exit 2 ;;
esac
if [ "${#INSTANCE}" -gt 32 ]; then
  echo "podium install: invalid instance id '$INSTANCE' (maximum 32 characters)" >&2; exit 2
fi

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
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
if [ "$INSTANCE" = "default" ]; then
  DEST="$DATA_HOME/podium"
  COMMAND="podium"
  DAEMON_UNIT="podium-daemon.service"
  UPDATE_UNIT="podium-update-user.service"
  UPDATE_TIMER="podium-update-user.timer"
else
  DEST="$DATA_HOME/podium-instances/$INSTANCE"
  COMMAND="podium-$INSTANCE"
  DAEMON_UNIT="podium-$INSTANCE-daemon.service"
  UPDATE_UNIT="podium-$INSTANCE-update.service"
  UPDATE_TIMER="podium-$INSTANCE-update.timer"
fi
BIN="$HOME/.local/bin"
mkdir -p "$BIN" "$(dirname "$DEST")"
STAGE="$(dirname "$DEST")/.podium-install.$$"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$TMP/$ASSET" -C "$STAGE"
[ -d "$STAGE/headless" ] || { echo "podium: tarball missing headless/ dir" >&2; rm -rf "$STAGE"; exit 1; }
rm -rf "$DEST"; mv "$STAGE/headless" "$DEST"; rm -rf "$STAGE"
if [ "$INSTANCE" = "default" ]; then
  ln -sf "$DEST/podium" "$BIN/$COMMAND"
else
  printf '#!/bin/sh\nexport PODIUM_INSTANCE=%s\nexec "%s/podium" "$@"\n' "$INSTANCE" "$DEST" > "$BIN/$COMMAND"
  chmod 755 "$BIN/$COMMAND"
fi
if ! "$BIN/$COMMAND" channel "$CHANNEL" >/dev/null; then
  echo "podium: installed, but could not persist update channel '$CHANNEL'; run: $COMMAND channel $CHANNEL" >&2
fi
echo "Installed instance '$INSTANCE' to $DEST"

# --- PATH hint ---
case ":$PATH:" in *":$BIN:"*) : ;; *) echo "Note: add $BIN to your PATH." ;; esac

if [ -z "$JOIN" ]; then
  echo "Done. Run: $COMMAND"
  exit 0
fi

# --- join mode: delegate to the CLI so config + unit text have ONE source of truth
#     (`podium setup --join` runs the same engine as interactive setup and renders the
#     daemon unit via renderDaemonUnit — issue #20). Non-interactive; safe piped. ---
JOIN_FALLBACK=""
if ! "$BIN/$COMMAND" setup --join "$JOIN" --persist systemd; then
  echo "podium: automated join failed; falling back to manual unit install" >&2
  JOIN_FALLBACK=1
  "$BIN/$COMMAND" join-config "$JOIN"
fi
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$UNIT_DIR"
if [ -n "$JOIN_FALLBACK" ]; then
  # Fallback unit — GENERATED from renderDaemonUnit() in apps/cli/src/cli-systemd.ts (the
  # single source; regenerate with `bun scripts/render-systemd.ts`). Do not hand-edit: the
  # lockstep test in apps/cli/src/cli-systemd.test.ts and `render-systemd.ts --check` (part
  # of `bun run lint`) both fail on drift.
  cat > "$TMP/podium-daemon.service" <<'EOF'
[Unit]
Description=Podium per-machine agent daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Environment=PODIUM_INSTANCE=default
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
  if [ "$INSTANCE" = "default" ]; then
    cp "$TMP/podium-daemon.service" "$UNIT_DIR/$DAEMON_UNIT"
  else
    sed -e "s/Environment=PODIUM_INSTANCE=default/Environment=PODIUM_INSTANCE=$INSTANCE/" \
      -e "s#ExecStart=%h/.local/bin/podium daemon#ExecStart=%h/.local/bin/$COMMAND daemon#" \
      "$TMP/podium-daemon.service" > "$UNIT_DIR/$DAEMON_UNIT"
  fi
fi
# --- auto-update timer: `podium update` on a daily cadence, restart the daemon only when it
#     actually swapped in a new bundle (exit 10). Opt out with --no-auto-update. ---
if [ -n "$AUTO_UPDATE" ]; then
  cat > "$UNIT_DIR/$UPDATE_UNIT" <<EOF
[Unit]
Description=Podium headless self-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=PODIUM_INSTANCE=$INSTANCE
ExecStart=/usr/bin/env sh -c '%h/.local/bin/$COMMAND update; ec=\$?; [ "\$ec" = 10 ] && systemctl --user try-restart $DAEMON_UNIT; exit 0'
EOF
  cat > "$UNIT_DIR/$UPDATE_TIMER" <<EOF
[Unit]
Description=Podium headless self-update (daily)

[Timer]
OnCalendar=daily
Persistent=true
Unit=$UPDATE_UNIT

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
    systemctl --user enable --now "$DAEMON_UNIT" || \
      echo "Could not start the user service automatically; run: systemctl --user enable --now $DAEMON_UNIT"
  fi
  if [ -n "$AUTO_UPDATE" ]; then
    systemctl --user enable --now "$UPDATE_TIMER" || \
      echo "Could not enable auto-update; run: systemctl --user enable --now $UPDATE_TIMER"
  fi
else
  echo "No systemd here. Start the daemon with: $COMMAND daemon"
fi
echo "Joined."
