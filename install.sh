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
INSTALL_AGENTS=""
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
    --agents) INSTALL_AGENTS="${2:?--agents requires a comma-separated value}"; shift 2 ;;
    --channel) CHANNEL="${2:?--channel requires a value}"; shift 2 ;;
    --no-auto-update) AUTO_UPDATE=""; shift ;;
    --instance) INSTANCE="${2:?--instance requires an ID}"; shift 2 ;;
    --instance=*) INSTANCE="${1#--instance=}"; shift ;;
    *) echo "podium install: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# --- platform detection -----------------------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OS" != "Linux" ]; then
  echo "podium: unsupported platform $OS/$ARCH (supported: linux x86_64 and arm64)" >&2
  exit 1
fi
case "$ARCH" in
  x86_64|amd64) ASSET="podium-headless-linux-x64.tar.gz" ;;
  aarch64|arm64) ASSET="podium-headless-linux-arm64.tar.gz" ;;
  *)
    echo "podium: unsupported platform $OS/$ARCH (supported: linux x86_64 and arm64)" >&2
    exit 1
    ;;
esac

case "$INSTANCE" in
  ""|[!a-z]*|*[!a-z0-9-]*)
    echo "podium install: invalid instance id '$INSTANCE' (use [a-z][a-z0-9-]{0,31})" >&2; exit 2 ;;
esac
if [ "${#INSTANCE}" -gt 32 ]; then
  echo "podium install: invalid instance id '$INSTANCE' (maximum 32 characters)" >&2; exit 2
fi

# --- unattended prerequisite bootstrap ------------------------------------------
# A copied install.sh must work on a bare distro image. The Settings command has a
# smaller outer bootstrap for the downloader needed to fetch this file; once here,
# install every runtime/building-block Podium and the three agent installers need.
as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n "$@"
  else
    echo "podium: missing prerequisites and cannot install them (run as root or configure passwordless sudo)" >&2
    exit 1
  fi
}

install_prerequisites() {
  echo "Installing Podium prerequisites…"
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl openssl git tar gzip bash coreutils
  elif command -v apk >/dev/null 2>&1; then
    as_root apk add --no-cache ca-certificates curl openssl git tar gzip bash coreutils
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y ca-certificates curl openssl git tar gzip bash coreutils
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y ca-certificates curl openssl git tar gzip bash coreutils
  elif command -v zypper >/dev/null 2>&1; then
    as_root zypper --non-interactive refresh
    as_root zypper --non-interactive install ca-certificates curl openssl git tar gzip bash coreutils
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -Sy --noconfirm ca-certificates curl openssl git tar gzip bash coreutils
  else
    echo "podium: missing prerequisites and no supported package manager found (apt, apk, dnf, yum, zypper, pacman)" >&2
    exit 1
  fi
}

NEED_PREREQUISITES=""
for tool in base64 openssl tar gzip git bash; do
  command -v "$tool" >/dev/null 2>&1 || NEED_PREREQUISITES=1
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  NEED_PREREQUISITES=1
fi
if [ ! -r /etc/ssl/certs/ca-certificates.crt ] && [ ! -r /etc/pki/tls/certs/ca-bundle.crt ]; then
  NEED_PREREQUISITES=1
fi
if [ -n "$NEED_PREREQUISITES" ]; then install_prerequisites; fi

for tool in base64 openssl tar gzip git bash; do
  command -v "$tool" >/dev/null 2>&1 || { echo "podium: prerequisite '$tool' is still unavailable" >&2; exit 1; }
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "podium: prerequisite 'curl or wget' is still unavailable" >&2
  exit 1
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
fetch_public() { # vendor installer fetch; never forwards a GitHub auth token
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "podium: need curl or wget" >&2; exit 1; fi
}

# Claude's official shell installer downloads and checksum-verifies a standalone
# binary, then asks that binary to self-stage. Some minimal/container runtimes
# expose the emulator or launcher as /proc/self/exe, so that final self-stage can
# fail even though the official binary is valid. Keep the vendor installer as the
# primary path, but reproduce its manifest verification before directly installing
# that same architecture-specific binary as a resilient fallback.
install_claude_standalone() {
  release_base="${PODIUM_CLAUDE_RELEASE_BASE_URL:-https://downloads.claude.ai/claude-code-releases}"
  case "$ARCH" in
    x86_64|amd64) claude_arch="x64" ;;
    aarch64|arm64) claude_arch="arm64" ;;
    *) echo "podium: unsupported Claude Code architecture '$ARCH'" >&2; return 1 ;;
  esac
  if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] || \
     ldd /bin/ls 2>&1 | grep -q musl; then
    claude_platform="linux-$claude_arch-musl"
  else
    claude_platform="linux-$claude_arch"
  fi

  latest="$TMP/claude-latest"
  manifest="$TMP/claude-manifest.json"
  binary="$TMP/claude-standalone"
  fetch_public "$release_base/latest" "$latest"
  IFS= read -r claude_version < "$latest" || true
  case "$claude_version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "podium: Claude release endpoint returned an invalid version" >&2; return 1 ;;
  esac
  case "$claude_version" in
    *[!0-9A-Za-z.+-]*)
      echo "podium: Claude release endpoint returned an unsafe version" >&2; return 1 ;;
  esac

  fetch_public "$release_base/$claude_version/manifest.json" "$manifest"
  checksum="$(tr -d '\n\r\t' < "$manifest" | sed -n \
    "s/.*\"$claude_platform\"[[:space:]]*:[[:space:]]*{[^}]*\"checksum\"[[:space:]]*:[[:space:]]*\"\([0-9a-f]\{64\}\)\".*/\1/p")"
  case "$checksum" in
    ""|*[!0-9a-f]*)
      echo "podium: Claude manifest has no valid checksum for $claude_platform" >&2; return 1 ;;
  esac
  [ "${#checksum}" -eq 64 ] || {
    echo "podium: Claude manifest checksum has an invalid length" >&2; return 1
  }

  fetch_public "$release_base/$claude_version/$claude_platform/claude" "$binary"
  actual="$(sha256sum "$binary" | cut -d' ' -f1)"
  if [ "$actual" != "$checksum" ]; then
    echo "podium: Claude standalone checksum verification FAILED" >&2
    return 1
  fi
  staged="$BIN/.claude.podium-$$"
  cp "$binary" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$BIN/claude"
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
PATH="$BIN:$PATH"; export PATH

# Pair as soon as Podium itself is installed. Bare-machine prerequisite and agent
# downloads can be slow enough to exhaust a short-lived code; the daemon can copy
# credentials and publish inventory while the three agent CLIs install below.
JOIN_FALLBACK=""
if [ -n "$JOIN" ]; then
  if ! "$BIN/$COMMAND" setup --join "$JOIN" --persist systemd; then
    echo "podium: automated join failed; falling back to manual unit install" >&2
    JOIN_FALLBACK=1
    "$BIN/$COMMAND" join-config "$JOIN"
  fi
fi

# --- optional agent bootstrap (the Settings → Add machine command requests all
#     three). Vendor installers are downloaded first, then run unattended. ---
if [ -n "$INSTALL_AGENTS" ]; then
  old_ifs="$IFS"; IFS=','
  for agent in $INSTALL_AGENTS; do
    case "$agent" in
      codex)
        url="${PODIUM_CODEX_INSTALL_URL:-https://chatgpt.com/codex/install.sh}"
        script="$TMP/codex-install.sh"
        echo "Installing Codex…"
        fetch_public "$url" "$script"
        CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR="$BIN" sh "$script"
        "$BIN/codex" --version >/dev/null
        ;;
      claude-code)
        command -v bash >/dev/null 2>&1 || { echo "podium: bash is required to install Claude Code" >&2; exit 1; }
        url="${PODIUM_CLAUDE_INSTALL_URL:-https://claude.ai/install.sh}"
        script="$TMP/claude-install.sh"
        echo "Installing Claude Code…"
        fetch_public "$url" "$script"
        if ! bash "$script" stable; then
          echo "Claude's self-installer could not stage the binary; using the checksum-verified standalone fallback…" >&2
          install_claude_standalone
        fi
        "$BIN/claude" --version >/dev/null
        ;;
      grok)
        command -v bash >/dev/null 2>&1 || { echo "podium: bash is required to install Grok" >&2; exit 1; }
        url="${PODIUM_GROK_INSTALL_URL:-https://x.ai/cli/install.sh}"
        script="$TMP/grok-install.sh"
        echo "Installing Grok…"
        fetch_public "$url" "$script"
        GROK_BIN_DIR="$BIN" bash "$script"
        "$BIN/grok" --version >/dev/null
        ;;
      *) echo "podium install: unsupported agent '$agent'" >&2; exit 2 ;;
    esac
  done
  IFS="$old_ifs"
fi

if [ -z "$JOIN" ]; then
  echo "Done. Run: $COMMAND"
  exit 0
fi

# `podium setup --join` above owns config + lifecycle setup through the same engine
# as interactive setup. What remains here is the fallback unit and update timer.
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

if [ -z "${PODIUM_DISABLE_SYSTEMD:-}" ] && command -v systemctl >/dev/null 2>&1 && \
   systemctl --user show-environment >/dev/null 2>&1; then
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
  # `podium setup --join` owns lifecycle setup. When user systemd is unavailable
  # its shared backend engine already falls back to a detached daemon and writes
  # the JSON run registry used by `podium status`/`stop`; starting another process
  # here races that daemon and corrupts ownership. Only the legacy manual-unit
  # fallback (setup itself failed) still needs a direct launch.
  if [ -n "$JOIN_FALLBACK" ]; then
    if [ -n "${PODIUM_STATE_DIR:-}" ]; then
      DAEMON_STATE="$PODIUM_STATE_DIR"
    elif [ "$INSTANCE" = "default" ]; then
      DAEMON_STATE="$HOME/.podium"
    else
      DAEMON_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/podium/$INSTANCE"
    fi
    mkdir -p "$DAEMON_STATE/logs"
    DAEMON_LOG="$DAEMON_STATE/logs/daemon.log"
    PODIUM_RUN_MODE=detached "$BIN/$COMMAND" daemon --takeover \
      </dev/null >>"$DAEMON_LOG" 2>&1 &
    echo "Started Podium daemon (detached; log $DAEMON_LOG)."
  else
    echo "No usable user systemd; Podium setup started the daemon detached."
  fi
fi
echo "Joined."
