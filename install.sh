#!/bin/sh
# Podium installer. Usage:
#   curl -fsSL .../install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --instance <ID>
#   curl -fsSL .../install.sh | sh -s -- --join <TOKEN> [--channel edge]
#   GH_TOKEN=<token> curl -fsSL -H "Authorization: Bearer $GH_TOKEN" .../install.sh | GH_TOKEN=$GH_TOKEN sh -s -- --channel edge
#
# THIS SCRIPT IS A BOOTSTRAP [POD-3274]. Its whole job is to put a signature-verified binary on
# disk and hand control to it. The verified binary is both the trust boundary and the UI
# boundary: everything after extraction — PATH, supervision, agents, pairing, the closing
# report — runs from signed code in `podium install-finish`, not from a script the user piped
# into a shell. This is the shape rustup, determinate-nix and Claude's own installer use.
set -eu

REPO="madeinorbit/podium"
CHANNEL="stable"
JOIN=""
INSTALL_AGENTS=""
INSTANCE="default"
VPS=""
# Ed25519 pubkey (SPKI/DER, base64). Commit the SAME value as PODIUM_UPDATE_PUBKEY in
# packages/runtime/src/update-delivery.ts — the lockstep test in Step 5 enforces they match. (A test
# override is allowed via PODIUM_INSTALL_PUBKEY.) The key is public; committing it is safe.
PUBKEY="${PODIUM_INSTALL_PUBKEY:-MCowBQYDK2VwAyEAG12/153QJI/SePyYeJQhBSbh1ZsFgkoMkwb823NiYOU=}"
GITHUB_AUTH_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

while [ $# -gt 0 ]; do
  case "$1" in
    --join) JOIN="${2:?--join requires a TOKEN}"; shift 2 ;;
    # Accepted and INERT — nothing has ever read the value they set. Whether they should mean
    # anything is POD-3309's call; taking them keeps existing docs and scripts working.
    --managed) shift ;;
    --shared) shift ;;
    --agents) INSTALL_AGENTS="${2:?--agents requires a comma-separated value}"; shift 2 ;;
    --channel) CHANNEL="${2:?--channel requires a value}"; shift 2 ;;
    --instance) INSTANCE="${2:?--instance requires an ID}"; shift 2 ;;
    --instance=*) INSTANCE="${1#--instance=}"; shift ;;
    --vps) VPS=1; shift ;;
    *) echo "podium install: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# --- presentation ----------------------------------------------------------------
# Deliberately minimal: four lines at most, and none of them is a command to copy. Everything
# with a decision or a copyable command in it is drawn by the binary, with clack.
# Colour only when stdout is a real terminal (under `curl … | sh` stdin is the pipe, stdout is
# not) and the terminal admits to being one. 214 ≈ Superade Yellow, the brand accent.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  BRAND="$(printf '\033[38;5;214m')"; BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"; RESET="$(printf '\033[0m')"
else
  BRAND=""; BOLD=""; DIM=""; RESET=""
fi
# The PODIUM wordmark, same coverage grid the web login screen and ASCII loader draw.
# GENERATED — regenerate with `bun scripts/render-install-banner.ts`; do not hand-edit.
banner() {
  printf '\n%s' "$BRAND"
  cat <<'ART'
      ▄▄▄▄▄▄▄    ▄▄▄▄▄▄   ▄▄▄▄▄▄    ▄▄▄ ▄▄▄   ▄▄▄ ▄▄▄▄    ▄▄▄▄
      ███▀▀███  ███▀▀██▄  ███▀▀██▄  ███ ▀██▄  ███  ████   ████
     ███   ███ ███   ███ ▄██▀  ███  ███  ███  ███  ████▄  █████
    ▄███  ███  ███  ▄██▀ ███   ███  ███  ███  ▀███ ▀████▄  ████▄
    ███  ▄███ ████  ███  ███   ███  ███  ███   ███  █████  ██▀██
   ████▄▄███▀ ███   ███  ███   ███  ███  ███   ███  ███▀██ ██ ███
   █████▀▀▀  ▄███   ███  ███   ███  ███  ████  ███  ███ ▀████ ███
  ████       ███▀  ████  ███   ███  ███  ████  ▀███  ██▄ ████▄ ███
 ▄███        ███   ████ ▄███  ▄███  ████  ███   ███  ███ ▀████ ▀██▄
 ███▀        █████████  █████████▀  ████  ████▄████  ███▄ ▀███  ███
 ▀▀▀          ▀▀▀▀▀▀    ▀▀▀▀▀▀▀▀    ▀▀▀▀   ▀▀▀▀▀▀▀    ▀▀▀  ▀▀▀  ▀▀▀
ART
  printf '%s%s      headless installer%s\n\n' "$RESET" "$DIM" "$RESET"
}
step()  { printf '%s→%s %s\n' "$BRAND" "$RESET" "$1"; }
done_() { printf '%s✓%s %s\n' "$BRAND" "$RESET" "$1"; }

banner

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

# --- bootstrap prerequisites ------------------------------------------------------
# ONLY what is needed to DOWNLOAD AND VERIFY. `git` and `bash` are needed by the vendor agent
# installers, not by this bootstrap, so they now live behind the handoff where a failure can be
# reported properly instead of apt-get output scrolling past.
#
# No other mainstream installer does this at all — ollama, the closest analogue, detects a
# missing tool and refuses with the per-distro command. We install because a copied install.sh
# must work on a bare distro image, which is exactly the one-paste VPS case ollama is not
# trying to serve. That justification covers this set and no more.
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
  step "Installing prerequisites (curl, openssl, tar…)"
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl openssl tar gzip coreutils
  elif command -v apk >/dev/null 2>&1; then
    as_root apk add --no-cache ca-certificates curl openssl tar gzip coreutils
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y ca-certificates curl openssl tar gzip coreutils
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y ca-certificates curl openssl tar gzip coreutils
  elif command -v zypper >/dev/null 2>&1; then
    as_root zypper --non-interactive refresh
    as_root zypper --non-interactive install ca-certificates curl openssl tar gzip coreutils
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -Sy --noconfirm ca-certificates curl openssl tar gzip coreutils
  else
    echo "podium: missing prerequisites and no supported package manager found (apt, apk, dnf, yum, zypper, pacman)" >&2
    exit 1
  fi
}

NEED_PREREQUISITES=""
for tool in base64 openssl tar gzip; do
  command -v "$tool" >/dev/null 2>&1 || NEED_PREREQUISITES=1
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  NEED_PREREQUISITES=1
fi
if [ ! -r /etc/ssl/certs/ca-certificates.crt ] && [ ! -r /etc/pki/tls/certs/ca-bundle.crt ]; then
  NEED_PREREQUISITES=1
fi
if [ -n "$NEED_PREREQUISITES" ]; then install_prerequisites; fi

for tool in base64 openssl tar gzip; do
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

step "Downloading $ASSET ($CHANNEL)"
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
done_ "Signature verified"

# --- install: extract to a temp dir on the target filesystem, then atomic rename ---
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
if [ "$INSTANCE" = "default" ]; then
  DEST="$DATA_HOME/podium"
  COMMAND="podium"
else
  DEST="$DATA_HOME/podium-instances/$INSTANCE"
  COMMAND="podium-$INSTANCE"
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
done_ "Installed instance '$INSTANCE' to $DEST"

# --- hand off to the verified binary ----------------------------------------------
# Reporting a failure is part of an installer's job, so it cannot depend on the thing that
# failed: probe first, and if the binary will not run, say so in plain text. rustup hits the
# same case (a noexec /tmp) and reports it the same way.
fallback_report() {
  echo "podium: the installed binary at $BIN/$COMMAND could not be run." >&2
  echo "        Nothing was configured. If /tmp or $DEST is mounted noexec, remount it and" >&2
  echo "        finish the install with:" >&2
  echo "          $BIN/$COMMAND install-finish --channel $CHANNEL --instance $INSTANCE \\" >&2
  echo "            --dest $DEST --bin $BIN --command $COMMAND" >&2
}
if ! "$BIN/$COMMAND" --version >/dev/null 2>&1; then
  fallback_report
  exit 1
fi

# NOT "$@": install.sh's own flags are not install-finish's. The join token travels in the
# ENVIRONMENT so a live pairing code stays out of /proc/*/cmdline, where every other user on
# the box can read it.
set -- install-finish --channel "$CHANNEL" --instance "$INSTANCE" \
  --dest "$DEST" --bin "$BIN" --command "$COMMAND"
[ -z "$INSTALL_AGENTS" ] || set -- "$@" --agents "$INSTALL_AGENTS"
[ -z "$VPS" ] || set -- "$@" --vps
[ -z "${PODIUM_NO_MODIFY_PATH:-}" ] || set -- "$@" --no-modify-path
if [ -n "$JOIN" ]; then
  PODIUM_JOIN_TOKEN="$JOIN"; export PODIUM_JOIN_TOKEN
fi

# Under `curl … | sh` stdin is the PIPE, but /dev/tty is still the controlling terminal — so
# reconnecting it is what lets one paste run the real interactive setup. rustup and
# determinate-nix use the same redirect for exactly this. When there is no terminal to
# reconnect (a CI runner, a provisioning script), say so rather than letting a prompt hang.
# The probe runs in a SUBSHELL deliberately: a redirection that cannot be opened is a FATAL
# error for a non-interactive POSIX shell, so `: < /dev/tty` in this shell would kill the
# installer outright (status 2) instead of answering the question. The device node existing is
# not enough either — a process with no controlling terminal gets ENXIO on open.
if ( : < /dev/tty ) 2>/dev/null; then
  exec "$BIN/$COMMAND" "$@" < /dev/tty
else
  exec "$BIN/$COMMAND" "$@" --no-interactive
fi
