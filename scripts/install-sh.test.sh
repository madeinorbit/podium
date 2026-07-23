#!/usr/bin/env bash
# scripts/install-sh.test.sh — runs install.sh against a local fixture "release".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"
export PODIUM_STATE_DIR="$HOME/.podium"

# --- build a fake signed release into $WORK/release ---
REL="$WORK/release"; mkdir -p "$REL/headless"
# Stub binary: emulates the subcommands install.sh drives. `setup --join` mirrors the real
# binary's installSystemd (writes the daemon unit) so the delegation path is observable;
# PODIUM_STUB_JOIN_FAIL forces it to fail so the fallback path can be tested.
cat > "$REL/headless/podium" <<'SH'
#!/bin/sh
instance="${PODIUM_INSTANCE:-default}"
if [ "$instance" = default ]; then
  daemon_unit=podium-daemon.service
  state_dir="${PODIUM_STATE_DIR:-$HOME/.podium}"
else
  daemon_unit="podium-$instance-daemon.service"
  state_dir="${PODIUM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/podium/$instance}"
fi
[ -n "${PODIUM_STUB_LOG:-}" ] && echo "stub-instance $instance $*" >> "$PODIUM_STUB_LOG"
case "$1" in
  channel) mkdir -p "$state_dir"; printf '%s\n' "$2" > "$state_dir/update-channel" ;;
  setup)
    if [ -n "${PODIUM_STUB_JOIN_FAIL:-}" ]; then echo "stub: setup fails" >&2; exit 1; fi
    UD="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$UD"
    printf '%s\n' "# stub unit written by podium setup --join" > "$UD/$daemon_unit"
    [ -n "${PODIUM_STUB_LOG:-}" ] && echo "stub-setup $*" >> "$PODIUM_STUB_LOG"
    if [ -n "${PODIUM_STUB_DAEMON_MARKER:-}" ]; then
      : > "$PODIUM_STUB_DAEMON_MARKER"
      "$0" daemon </dev/null >/dev/null 2>&1 &
    fi
    ;;
  join-config)
    [ -n "${PODIUM_STUB_LOG:-}" ] && echo "stub-join-config $*" >> "$PODIUM_STUB_LOG"
    ;;
  daemon)
    if [ -n "${PODIUM_STUB_DAEMON_MARKER:-}" ]; then
      : > "$PODIUM_STUB_DAEMON_MARKER"
      while [ -e "$PODIUM_STUB_DAEMON_MARKER" ]; do sleep 1; done
    fi
    ;;
esac
echo podium-stub "$@"
SH
chmod +x "$REL/headless/podium"
echo "9.9.9" > "$REL/headless/VERSION"
( cd "$REL" && tar -czf podium-headless-linux-x64.tar.gz headless )
# sign with a throwaway ed25519 key; write its pubkey where install.sh expects an override
openssl genpkey -algorithm ed25519 -out "$WORK/priv.pem" 2>/dev/null
openssl pkey -in "$WORK/priv.pem" -pubout -outform DER 2>/dev/null | base64 -w0 > "$WORK/pub.b64"
openssl pkeyutl -sign -inkey "$WORK/priv.pem" -rawin \
  -in "$REL/podium-headless-linux-x64.tar.gz" -out "$REL/podium-headless-linux-x64.tar.gz.sig.raw"
base64 -w0 "$REL/podium-headless-linux-x64.tar.gz.sig.raw" > "$REL/podium-headless-linux-x64.tar.gz.sig"
# The fixture payload is architecture-neutral; duplicate the signed bytes under
# the ARM64 release name so platform selection is tested independently of compilation.
cp "$REL/podium-headless-linux-x64.tar.gz" "$REL/podium-headless-linux-arm64.tar.gz"
cp "$REL/podium-headless-linux-x64.tar.gz.sig" "$REL/podium-headless-linux-arm64.tar.gz.sig"

# install.sh reads PODIUM_INSTALL_BASE (file:// or http) + PODIUM_INSTALL_PUBKEY (override) for tests.
export PODIUM_INSTALL_BASE="file://$REL"
PODIUM_INSTALL_PUBKEY="$(cat "$WORK/pub.b64")"
export PODIUM_INSTALL_PUBKEY

# Local vendor-installer fixtures: each writes the command install.sh verifies,
# so --agents is exercised without reaching the network.
AGENT_REL="$WORK/agents"; mkdir -p "$AGENT_REL"
cat > "$AGENT_REL/codex.sh" <<'SH'
#!/bin/sh
case "${CODEX_NON_INTERACTIVE:-}" in 1) : ;; *) exit 41 ;; esac
[ -z "${PODIUM_EXPECT_DAEMON_MARKER:-}" ] || [ -e "$PODIUM_EXPECT_DAEMON_MARKER" ] || exit 42
bin="${CODEX_INSTALL_DIR:-$HOME/.local/bin}"; mkdir -p "$bin"
printf '#!/bin/sh\necho codex-fixture\n' > "$bin/codex"; chmod +x "$bin/codex"
SH
cat > "$AGENT_REL/claude.sh" <<'SH'
#!/bin/bash
test "${1:-}" = stable
[ -z "${PODIUM_EXPECT_DAEMON_MARKER:-}" ] || [ -e "$PODIUM_EXPECT_DAEMON_MARKER" ] || exit 42
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\necho claude-fixture\n' > "$HOME/.local/bin/claude"; chmod +x "$HOME/.local/bin/claude"
SH
cat > "$AGENT_REL/grok.sh" <<'SH'
#!/bin/bash
[ -z "${PODIUM_EXPECT_DAEMON_MARKER:-}" ] || [ -e "$PODIUM_EXPECT_DAEMON_MARKER" ] || exit 42
mkdir -p "${GROK_BIN_DIR:?}"
printf '#!/bin/sh\necho grok-fixture\n' > "$GROK_BIN_DIR/grok"; chmod +x "$GROK_BIN_DIR/grok"
SH
cat > "$AGENT_REL/claude-stage-fails.sh" <<'SH'
#!/bin/bash
test "${1:-}" = stable
exit 91
SH

# Fixture for Claude's checksum-verified standalone fallback. The binary is a
# script only because this test asserts installer routing and integrity; the real
# ARM acceptance below exercises Anthropic's native AArch64 executable.
CLAUDE_REL="$WORK/claude-releases"
CLAUDE_VERSION="2.1.999"
mkdir -p "$CLAUDE_REL/$CLAUDE_VERSION/linux-x64"
printf '%s\n' "$CLAUDE_VERSION" > "$CLAUDE_REL/latest"
cat > "$CLAUDE_REL/$CLAUDE_VERSION/linux-x64/claude" <<'SH'
#!/bin/sh
echo claude-standalone-fixture
SH
chmod +x "$CLAUDE_REL/$CLAUDE_VERSION/linux-x64/claude"
CLAUDE_SHA="$(sha256sum "$CLAUDE_REL/$CLAUDE_VERSION/linux-x64/claude" | cut -d' ' -f1)"
printf '{"platforms":{"linux-x64":{"checksum":"%s"}}}\n' "$CLAUDE_SHA" \
  > "$CLAUDE_REL/$CLAUDE_VERSION/manifest.json"

echo "== plain install =="
sh "$ROOT/install.sh"
test -x "$HOME/.local/bin/podium"            || { echo FAIL: no launcher symlink; exit 1; }
test -f "$HOME/.local/share/podium/VERSION"  || { echo FAIL: bundle not installed; exit 1; }

echo "== named install has an independent root and bound command =="
printf 'keep\n' > "$HOME/.local/share/podium/DEFAULT-SENTINEL"
rm -f "$WORK/stub.log"
env -u PODIUM_STATE_DIR PODIUM_STUB_LOG="$WORK/stub.log" sh "$ROOT/install.sh" --instance blue
test -x "$HOME/.local/bin/podium-blue" || { echo FAIL: no named launcher; exit 1; }
test -f "$HOME/.local/share/podium-instances/blue/VERSION" || { echo FAIL: named bundle not installed; exit 1; }
test -f "$HOME/.local/share/podium/DEFAULT-SENTINEL" || { echo FAIL: named install replaced default bundle; exit 1; }
env -u PODIUM_STATE_DIR PODIUM_STUB_LOG="$WORK/stub.log" "$HOME/.local/bin/podium-blue" status >/dev/null
grep -F 'stub-instance blue status' "$WORK/stub.log" >/dev/null || { echo FAIL: named launcher did not bind identity; exit 1; }
test -f "$HOME/.local/state/podium/blue/update-channel" || { echo FAIL: named command did not use named state; exit 1; }

echo "== invalid instance ids fail before installation =="
if sh "$ROOT/install.sh" --instance Blue 2>/dev/null; then echo "FAIL: invalid instance accepted"; exit 1; fi

echo "== edge install persists update channel =="
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$PODIUM_STATE_DIR"
sh "$ROOT/install.sh" --channel edge
test "$(cat "$PODIUM_STATE_DIR/update-channel" 2>/dev/null || true)" = "edge" || { echo "FAIL: edge install did not persist update channel"; exit 1; }

echo "== arm64 hosts select the arm64 release asset =="
ARCHBIN="$WORK/archbin"; mkdir -p "$ARCHBIN"
cat > "$ARCHBIN/uname" <<'SH'
#!/bin/sh
case "${1:-}" in
  -s) echo Linux ;;
  -m) echo aarch64 ;;
  *) echo Linux ;;
esac
SH
chmod +x "$ARCHBIN/uname"
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$PODIUM_STATE_DIR"
arm_output="$(env PATH="$ARCHBIN:$PATH" sh "$ROOT/install.sh")"
printf '%s\n' "$arm_output" | grep -F 'Downloading podium-headless-linux-arm64.tar.gz' >/dev/null \
  || { echo "FAIL: arm64 host did not select arm64 asset"; exit 1; }
test -f "$HOME/.local/share/podium/VERSION" || { echo FAIL: arm64-named bundle not installed; exit 1; }

echo "== agent bootstrap is unattended and installs all requested CLIs =="
rm -f "$HOME/.local/bin/codex" "$HOME/.local/bin/claude" "$HOME/.local/bin/grok"
PODIUM_CODEX_INSTALL_URL="file://$AGENT_REL/codex.sh" \
PODIUM_CLAUDE_INSTALL_URL="file://$AGENT_REL/claude.sh" \
PODIUM_GROK_INSTALL_URL="file://$AGENT_REL/grok.sh" \
  sh "$ROOT/install.sh" --agents codex,claude-code,grok
test -x "$HOME/.local/bin/codex" || { echo FAIL: Codex missing; exit 1; }
test -x "$HOME/.local/bin/claude" || { echo FAIL: Claude missing; exit 1; }
test -x "$HOME/.local/bin/grok" || { echo FAIL: Grok missing; exit 1; }

echo "== join starts before slow agent bootstrap can expire its code =="
ORDER_MARKER="$WORK/join-before-agents"
rm -f "$ORDER_MARKER" "$HOME/.local/bin/codex" "$HOME/.local/bin/claude" "$HOME/.local/bin/grok"
PODIUM_DISABLE_SYSTEMD=1 PODIUM_STUB_DAEMON_MARKER="$ORDER_MARKER" \
PODIUM_EXPECT_DAEMON_MARKER="$ORDER_MARKER" \
PODIUM_CODEX_INSTALL_URL="file://$AGENT_REL/codex.sh" \
PODIUM_CLAUDE_INSTALL_URL="file://$AGENT_REL/claude.sh" \
PODIUM_GROK_INSTALL_URL="file://$AGENT_REL/grok.sh" \
  sh "$ROOT/install.sh" --join TESTTOKEN --no-auto-update --agents codex,claude-code,grok
test -e "$ORDER_MARKER" || { echo FAIL: join did not start before agents; exit 1; }
rm -f "$ORDER_MARKER"

echo "== Claude falls back to the checksum-verified official standalone binary =="
rm -f "$HOME/.local/bin/claude"
fallback_output="$(PODIUM_CLAUDE_INSTALL_URL="file://$AGENT_REL/claude-stage-fails.sh" \
  PODIUM_CLAUDE_RELEASE_BASE_URL="file://$CLAUDE_REL" \
  sh "$ROOT/install.sh" --agents claude-code 2>&1)"
printf '%s\n' "$fallback_output" | grep -F 'checksum-verified standalone fallback' >/dev/null \
  || { echo "FAIL: Claude standalone fallback was not reported"; exit 1; }
test "$("$HOME/.local/bin/claude" --version)" = "claude-standalone-fixture" \
  || { echo "FAIL: Claude standalone fallback was not installed"; exit 1; }

echo "== Claude standalone fallback rejects a bad manifest checksum =="
rm -f "$HOME/.local/bin/claude"
printf '{"platforms":{"linux-x64":{"checksum":"%064d"}}}\n' 0 \
  > "$CLAUDE_REL/$CLAUDE_VERSION/manifest.json"
if PODIUM_CLAUDE_INSTALL_URL="file://$AGENT_REL/claude-stage-fails.sh" \
  PODIUM_CLAUDE_RELEASE_BASE_URL="file://$CLAUDE_REL" \
  sh "$ROOT/install.sh" --agents claude-code >/dev/null 2>&1; then
  echo "FAIL: Claude fallback accepted a bad checksum"
  exit 1
fi
test ! -e "$HOME/.local/bin/claude" || { echo "FAIL: bad-checksum Claude binary installed"; exit 1; }

echo "== join starts the daemon unattended without a usable user systemd =="
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$HOME/.config/systemd" "$PODIUM_STATE_DIR"
DAEMON_MARKER="$WORK/daemon-running"
PODIUM_DISABLE_SYSTEMD=1 PODIUM_STUB_DAEMON_MARKER="$DAEMON_MARKER" \
  sh "$ROOT/install.sh" --join TESTTOKEN --no-auto-update
test -e "$DAEMON_MARKER" || { echo FAIL: no-systemd join did not start daemon; exit 1; }
rm -f "$DAEMON_MARKER"

echo "== authenticated fetch sends GitHub token =="
AUTHBIN="$WORK/authbin"; mkdir -p "$AUTHBIN"
cat > "$AUTHBIN/curl" <<'SH'
#!/bin/sh
log="${PODIUM_CURL_LOG:?}"
out=""
url=""
config=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --config) config="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$config" ] && cat "$config" >> "$log"
case "$url" in
  file://*) cp "${url#file://}" "$out" ;;
  *) echo "unexpected url: $url" >&2; exit 1 ;;
esac
SH
chmod +x "$AUTHBIN/curl"
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$PODIUM_STATE_DIR" "$WORK/curl.log"
env PATH="$AUTHBIN:$PATH" GH_TOKEN="gh_testtoken" PODIUM_CURL_LOG="$WORK/curl.log" sh "$ROOT/install.sh" --channel edge
grep -F 'Authorization: Bearer gh_testtoken' "$WORK/curl.log" >/dev/null || { echo "FAIL: authenticated install did not send GitHub token"; exit 1; }

# Stub systemctl + loginctl so --join runs write the unit FILES without touching the real
# user session; we assert on the written files, not on systemctl succeeding.
STUB="$WORK/bin"; mkdir -p "$STUB"
printf '#!/bin/sh\nexit 0\n' > "$STUB/systemctl"; chmod +x "$STUB/systemctl"
printf '#!/bin/sh\nexit 0\n' > "$STUB/loginctl"; chmod +x "$STUB/loginctl"
export PATH="$STUB:$PATH"
UNIT="$HOME/.config/systemd/user"

echo "== named join owns only named supervision and update units =="
rm -rf "$HOME/.local/share/podium-instances/blue" "$HOME/.local/bin/podium-blue" "$HOME/.config/systemd" "$WORK/stub.log"
env -u PODIUM_STATE_DIR PODIUM_STUB_LOG="$WORK/stub.log" sh "$ROOT/install.sh" --instance blue --join TESTTOKEN
grep -F 'stub-instance blue setup --join TESTTOKEN --persist systemd' "$WORK/stub.log" >/dev/null \
  || { echo "FAIL: named join did not route through named command"; exit 1; }
test -f "$UNIT/podium-blue-daemon.service" || { echo FAIL: named join did not write named daemon unit; exit 1; }
test -f "$UNIT/podium-blue-update.service" || { echo FAIL: named join did not write named update unit; exit 1; }
test -f "$UNIT/podium-blue-update.timer" || { echo FAIL: named join did not write named update timer; exit 1; }
grep -F 'Environment=PODIUM_INSTANCE=blue' "$UNIT/podium-blue-update.service" >/dev/null \
  || { echo "FAIL: named update unit lacks identity"; exit 1; }
grep -F 'podium-blue update' "$UNIT/podium-blue-update.service" >/dev/null \
  || { echo "FAIL: named update unit targets another install"; exit 1; }
grep -F 'try-restart podium-blue-daemon.service' "$UNIT/podium-blue-update.service" >/dev/null \
  || { echo "FAIL: named update unit restarts another daemon"; exit 1; }
test ! -e "$UNIT/podium-update-user.timer" || { echo "FAIL: named join wrote default update timer"; exit 1; }

echo "== join delegates to podium setup --join (one engine, one unit source) =="
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$HOME/.config/systemd"
env PODIUM_STUB_LOG="$WORK/stub.log" sh "$ROOT/install.sh" --join TESTTOKEN
grep -F 'stub-setup setup --join TESTTOKEN --persist systemd' "$WORK/stub.log" >/dev/null \
  || { echo "FAIL: join did not delegate to podium setup --join --persist systemd"; exit 1; }
test -f "$UNIT/podium-daemon.service"       || { echo FAIL: join did not write daemon unit; exit 1; }
test -f "$UNIT/podium-update-user.service"  || { echo FAIL: join did not write update service; exit 1; }
test -f "$UNIT/podium-update-user.timer"    || { echo FAIL: join did not write update timer; exit 1; }

echo "== join falls back to a manual unit when podium setup fails =="
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$HOME/.config/systemd" "$WORK/stub.log"
env PODIUM_STUB_JOIN_FAIL=1 PODIUM_STUB_LOG="$WORK/stub.log" sh "$ROOT/install.sh" --join TESTTOKEN
grep -F 'stub-join-config join-config TESTTOKEN' "$WORK/stub.log" >/dev/null \
  || { echo "FAIL: fallback did not run join-config"; exit 1; }
test -f "$UNIT/podium-daemon.service"       || { echo FAIL: fallback did not write daemon unit; exit 1; }
grep -F 'RestartPreventExitStatus=78' "$UNIT/podium-daemon.service" >/dev/null \
  || { echo "FAIL: fallback unit drifted from renderDaemonUnit (no RestartPreventExitStatus)"; exit 1; }

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
