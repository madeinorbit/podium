#!/bin/sh
# SPIKE (issue #213) — turnkey headless bootstrap for a fresh VPS.
#
# Proves out the four mechanics the design doc (docs/design/headless-bootstrap.md) argues for,
# in a form that can be run end-to-end today:
#
#   1. controllable harness set        --harnesses claude-code,codex
#   2. idempotent re-runs              fingerprint state file, --resume/--force/--reset
#   3. rootless install                everything into $HOME; apt only behind --with-apt
#   4. inventory reporting             `--inventory` emits the Inventory shape §4.4 wants
#
# NOT production. The recipe table here is hand-written shell; the real thing derives it from
# HarnessAdapter.install (design §4.1) so the registry stays the single source of truth.
# Deliberately does NOT touch credentials — that is #212's job over the paired channel (§4.5).
#
# Usage:
#   ./bootstrap-spike.sh --harnesses claude-code,codex [--no-tools] [--dry-run]
#   ./bootstrap-spike.sh --list-modules | --print-plan | --inventory
#   ./bootstrap-spike.sh --harnesses all --force-reinstall
set -eu

HARNESSES=""
TOOLS=""
WANT_TOOLS=1
DRY=0
FORCE=0
WITH_APT=0
ACTION="install"

STATE_DIR="${PODIUM_STATE_DIR:-$HOME/.podium}"
STATE="$STATE_DIR/bootstrap.state"
BIN="${PODIUM_BOOTSTRAP_BIN:-$HOME/.local/bin}"   # overridable so tests need not touch $HOME

ALL_HARNESSES="claude-code codex grok opencode cursor"
ALL_TOOLS="bun uv jq rg fd gh"

# ---------------------------------------------------------------------------
# recipe table  —  name | bin | bindir | fingerprint | installer
# The fingerprint is what makes re-runs honest: bump it (new version, new url,
# new sha) and exactly that step re-runs. Nothing else does.
# ---------------------------------------------------------------------------
recipe_bin() {
  case "$1" in
    claude-code) echo claude ;;
    codex)       echo codex ;;
    grok)        echo grok ;;
    opencode)    echo opencode ;;
    cursor)      echo cursor-agent ;;
    bun)         echo bun ;;
    uv)          echo uv ;;
    jq)          echo jq ;;
    rg)          echo rg ;;
    fd)          echo fd ;;
    gh)          echo gh ;;
    *) echo "" ;;
  esac
}

# Every dir an installer may drop a binary into. The daemon's systemd unit PATH
# must be the union of these — see docs/design/headless-bootstrap.md §2b, where a
# stock unit could not see ~/.bun/bin and codex went invisible.
bin_dirs() {
  echo "$HOME/.local/bin"
  echo "$HOME/.bun/bin"
  echo "$HOME/.opencode/bin"
  echo "$HOME/.grok/bin"
  echo "$HOME/.cargo/bin"
}

# Pinned identifiers. Real impl: sha256 of the fetched installer, checked before exec,
# with a CI job that auto-PRs on upstream drift (ACFS's checksum-monitor pattern).
recipe_fingerprint() {
  case "$1" in
    claude-code) echo "curl-sh:claude.ai/install.sh:stable" ;;
    codex)       echo "gh-release:openai/codex:latest-musl" ;;
    grok)        echo "curl-sh:x.ai/cli/install.sh:stable" ;;
    opencode)    echo "curl-sh:opencode.ai/install:stable" ;;
    cursor)      echo "curl-sh:cursor.com/install:stable" ;;
    bun)         echo "curl-sh:bun.sh/install:stable" ;;
    uv)          echo "curl-sh:astral.sh/uv/install.sh:stable" ;;
    jq)          echo "gh-release:jqlang/jq:latest" ;;
    rg)          echo "gh-release:BurntSushi/ripgrep:14.1.1" ;;
    fd)          echo "gh-release:sharkdp/fd:v10.2.0" ;;
    gh)          echo "gh-release:cli/cli:latest" ;;
    *) echo "unknown" ;;
  esac
}

arch_triple() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x86_64" ;;
    aarch64|arm64) echo "aarch64" ;;
    *) die "unsupported arch $(uname -m)" ;;
  esac
}
arch_short() { case "$(uname -m)" in x86_64|amd64) echo amd64 ;; aarch64|arm64) echo arm64 ;; esac; }
# Inventory speaks the protocol's arch vocabulary ('x64'|'arm64'), which is NOT the
# vocabulary release assets use ('amd64'/'x86_64'). Keep them apart on purpose.
arch_inventory() { case "$(uname -m)" in x86_64|amd64) echo x64 ;; aarch64|arm64) echo arm64 ;; esac; }

# There is no `podium --version` today (no flag, no subcommand) and bare `podium` will
# START A SERVER — so never probe it. Read the installed bundle's marker if one exists.
# Filed as discovered work: the daemon cannot report its own version without this.
podium_version() {
  for f in "${XDG_DATA_HOME:-$HOME/.local/share}/podium/VERSION" \
           "${XDG_DATA_HOME:-$HOME/.local/share}/podium/package.json"; do
    [ -f "$f" ] || continue
    case "$f" in
      *VERSION) head -1 "$f" | tr -d '\r\n'; return ;;
      *.json) sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$f" | head -1 | tr -d '\r\n'; return ;;
    esac
  done
  echo "unknown"
}

recipe_install() {
  a="$(arch_triple)"; s="$(arch_short)"
  case "$1" in
    claude-code) curl -fsSL https://claude.ai/install.sh | bash ;;
    grok)        curl -fsSL https://x.ai/cli/install.sh | bash ;;
    opencode)    curl -fsSL https://opencode.ai/install | bash ;;
    cursor)      curl -fsS  https://cursor.com/install | bash ;;
    # Release binary, not `npm i -g @openai/codex`: the npm path drags in a whole
    # Node >=22 toolchain for one CLI. (And `npm i -g codex`, unscoped, is a
    # different, unrelated package — an easy way to install the wrong thing.)
    codex)
      url="https://github.com/openai/codex/releases/latest/download/codex-${a}-unknown-linux-musl.tar.gz"
      tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
      curl -fsSL "$url" -o "$tmp/codex.tgz"
      tar -xzf "$tmp/codex.tgz" -C "$tmp"
      mkdir -p "$BIN"
      find "$tmp" -type f -name 'codex*' -perm -u+x -exec cp {} "$BIN/codex" \; -quit
      chmod +x "$BIN/codex"
      ;;
    bun) curl -fsSL https://bun.sh/install | bash ;;
    uv)  curl -LsSf https://astral.sh/uv/install.sh | sh ;;
    jq)
      mkdir -p "$BIN"
      curl -fsSL "https://github.com/jqlang/jq/releases/latest/download/jq-linux-${s}" -o "$BIN/jq"
      chmod +x "$BIN/jq" ;;
    rg)
      mkdir -p "$BIN"
      curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${a}-unknown-linux-musl.tar.gz" \
        | tar xz --strip-components=1 -C "$BIN" --wildcards '*/rg' ;;
    fd)
      mkdir -p "$BIN"
      curl -fsSL "https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-${a}-unknown-linux-musl.tar.gz" \
        | tar xz --strip-components=1 -C "$BIN" --wildcards '*/fd' ;;
    gh)
      mkdir -p "$BIN"
      tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
      ver="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
      curl -fsSL "https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_linux_${s}.tar.gz" -o "$tmp/gh.tgz"
      tar -xzf "$tmp/gh.tgz" -C "$tmp"
      cp "$tmp/gh_${ver}_linux_${s}/bin/gh" "$BIN/gh"; chmod +x "$BIN/gh" ;;
    *) die "no recipe for '$1'" ;;
  esac
}

# ---------------------------------------------------------------------------
log()  { printf '\033[36m::\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

state_get() { [ -f "$STATE" ] && awk -F'\t' -v k="$1" '$1==k{print $2}' "$STATE" || true; }
state_put() {
  mkdir -p "$STATE_DIR"
  touch "$STATE"
  awk -F'\t' -v k="$1" '$1!=k' "$STATE" > "$STATE.tmp" 2>/dev/null || true
  printf '%s\t%s\n' "$1" "$2" >> "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}

# A step runs when: forced, OR never run, OR its fingerprint moved, OR its binary vanished.
# That last clause matters — state files lie after someone rm's a binary by hand.
needs_run() {
  name="$1"; fp="$2"; bin="$3"
  [ "$FORCE" = 1 ] && return 0
  [ "$(state_get "$name")" != "$fp" ] && return 0
  [ -n "$bin" ] && ! have "$bin" && return 0
  return 1
}

have() { command -v "$1" >/dev/null 2>&1; }

run_step() {
  name="$1"
  fp="$(recipe_fingerprint "$name")"
  bin="$(recipe_bin "$name")"
  if ! needs_run "$name" "$fp" "$bin"; then
    log "skip $name (up to date)"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    printf '  would install %-12s [%s]\n' "$name" "$fp"
    return 0
  fi
  log "install $name"
  if ( recipe_install "$name" ) >&2; then
    state_put "$name" "$fp"
  else
    warn "$name failed — continuing (re-run to retry just this step)"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Inventory — the exact shape docs/design/headless-bootstrap.md §4.4 wants the daemon
# to send in its pair/hello frame, and that `podium doctor --json` should emit.
# ---------------------------------------------------------------------------
probe_version() {
  bin="$1"
  have "$bin" || { echo ""; return; }
  "$bin" --version 2>/dev/null | head -1 | tr -d '\r' | sed 's/"/\\"/g' || echo "?"
}

emit_inventory() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(arch_inventory)"
  printf '{\n  "os": "%s",\n  "arch": "%s",\n' "$os" "$arch"
  printf '  "podiumVersion": "%s",\n' "$(podium_version)"

  printf '  "agents": ['
  first=1
  for h in $ALL_HARNESSES; do
    b="$(recipe_bin "$h")"
    have "$b" || continue
    [ "$first" = 0 ] && printf ','
    first=0
    printf '\n    {"kind": "%s", "version": "%s", "path": "%s"}' \
      "$h" "$(probe_version "$b")" "$(command -v "$b")"
  done
  [ "$first" = 0 ] && printf '\n  '
  printf '],\n'

  printf '  "tools": ['
  first=1
  for t in $ALL_TOOLS; do
    have "$t" || continue
    [ "$first" = 0 ] && printf ','
    first=0
    printf '\n    {"name": "%s", "version": "%s"}' "$t" "$(probe_version "$t")"
  done
  [ "$first" = 0 ] && printf '\n  '
  printf ']\n}\n'
}

# The union of bin_dirs(), for the daemon unit. See §2b: a stock unit's PATH omits
# ~/.bun/bin and ~/.opencode/bin, so daemon-spawned codex/opencode ENOENT while the
# same binaries work fine in the operator's ssh shell.
emit_daemon_path() {
  p=""
  for d in $(bin_dirs); do [ -d "$d" ] && p="${p:+$p:}$d"; done
  echo "${p}:/usr/local/bin:/usr/bin:/bin"
}

ensure_path() {
  case ":$PATH:" in *":$BIN:"*) : ;; *) PATH="$BIN:$PATH"; export PATH ;; esac
  for d in $(bin_dirs); do
    [ -d "$d" ] || continue
    case ":$PATH:" in *":$d:"*) : ;; *) PATH="$d:$PATH"; export PATH ;; esac
  done
}

# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --harnesses) [ $# -ge 2 ] || die "--harnesses requires a list (or 'none'/'all')"
                 HARNESSES="$2"; shift 2 ;;
    --tools) [ $# -ge 2 ] || die "--tools requires a list (or 'none'/'all')"
             TOOLS="$2"; shift 2 ;;
    --no-tools) WANT_TOOLS=0; shift ;;
    --with-apt) WITH_APT=1; shift ;;
    --dry-run|--print-plan) DRY=1; shift ;;
    --force-reinstall) FORCE=1; shift ;;
    --reset-state) rm -f "$STATE"; log "state reset"; exit 0 ;;
    --list-modules) ACTION="list"; shift ;;
    --inventory) ACTION="inventory"; shift ;;
    --daemon-path) ACTION="daemon-path"; shift ;;
    -h|--help) usage 0 ;;
    *) die "unknown arg '$1' (--help)" ;;
  esac
done

ensure_path

case "$ACTION" in
  list)
    echo "harnesses:"; for h in $ALL_HARNESSES; do
      printf '  %-12s bin=%-13s %s\n' "$h" "$(recipe_bin "$h")" "$(have "$(recipe_bin "$h")" && echo '[installed]' || echo '')"
    done
    echo "tools:"; for t in $ALL_TOOLS; do
      printf '  %-12s %s\n' "$t" "$(have "$t" && echo '[installed]' || echo '')"
    done
    exit 0 ;;
  inventory) emit_inventory; exit 0 ;;
  daemon-path) emit_daemon_path; exit 0 ;;
esac

[ "$(uname -s)" = "Linux" ] || die "linux only (macOS is served by the desktop app)"

# Resolve selections. Both sets are closed enums, so we can validate and name the mistake
# instead of failing later inside an installer.
validate_in() { # validate_in <item> <universe> <label>
  case " $2 " in *" $1 "*) return 0 ;; esac
  die "unknown $3 '$1' (known: $(echo "$2" | tr ' ' ','))"
}

case "$HARNESSES" in
  all)      SELECTED="$ALL_HARNESSES" ;;
  none)     SELECTED="" ;;
  "")       SELECTED="claude-code"; log "no --harnesses given; defaulting to claude-code" ;;
  *)        SELECTED="$(echo "$HARNESSES" | tr ',' ' ')" ;;
esac
for h in $SELECTED; do validate_in "$h" "$ALL_HARNESSES" harness; done

case "$TOOLS" in
  ""|all)   SELECTED_TOOLS="$ALL_TOOLS" ;;
  none)     SELECTED_TOOLS="" ;;
  *)        SELECTED_TOOLS="$(echo "$TOOLS" | tr ',' ' ')" ;;
esac
[ "$WANT_TOOLS" = 1 ] || SELECTED_TOOLS=""
for t in $SELECTED_TOOLS; do validate_in "$t" "$ALL_TOOLS" tool; done

have curl || die "need curl"
mkdir -p "$BIN"

if [ "$WITH_APT" = 1 ]; then
  if [ "$(id -u)" = 0 ] || have sudo; then
    log "apt: build-essential git openssl ca-certificates"
    [ "$DRY" = 1 ] || ${SUDO:-$([ "$(id -u)" = 0 ] || echo sudo)} \
      sh -c 'apt-get update -qq && apt-get install -y -qq build-essential git openssl ca-certificates' >&2
  else
    warn "--with-apt but no root and no sudo; skipping"
  fi
fi

[ "$DRY" = 1 ] && echo "plan:"

failed=""
for t in $SELECTED_TOOLS; do run_step "$t" || failed="$failed $t"; done
for h in $SELECTED; do run_step "$h" || failed="$failed $h"; done

if [ "$DRY" = 1 ]; then
  echo
  echo "daemon unit PATH would be:"
  echo "  $(emit_daemon_path)"
  exit 0
fi

ensure_path
echo
log "inventory:"
emit_inventory

echo
if [ -n "$failed" ]; then
  warn "failed:$failed — re-run to retry only those steps"
fi

# Credentials are deliberately absent. The bootstrap's contract ends at "binaries present";
# logins arrive from the server over the paired daemon channel (#212), and GitHub auth via
# #214. Nothing here should ever be handed a bearer token on its argv.
cat >&2 <<EOF

Next:
  1. pair this machine:  curl -fsSL <server>/install.sh | sh -s -- --join <TOKEN>
  2. the daemon then pulls its environment (logins, env, plugins) from the server  [#212]
  3. set the unit PATH:  Environment=PATH=$(emit_daemon_path)                      [#213 §2b]

Harness logins are NOT configured here, by design.
EOF
