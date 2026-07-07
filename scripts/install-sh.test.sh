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
case "$1" in
  channel) mkdir -p "$PODIUM_STATE_DIR"; printf '%s\n' "$2" > "$PODIUM_STATE_DIR/update-channel" ;;
  setup)
    if [ -n "${PODIUM_STUB_JOIN_FAIL:-}" ]; then echo "stub: setup fails" >&2; exit 1; fi
    UD="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$UD"
    printf '%s\n' "# stub unit written by podium setup --join" > "$UD/podium-daemon.service"
    [ -n "${PODIUM_STUB_LOG:-}" ] && echo "stub-setup $*" >> "$PODIUM_STUB_LOG"
    ;;
  join-config)
    [ -n "${PODIUM_STUB_LOG:-}" ] && echo "stub-join-config $*" >> "$PODIUM_STUB_LOG"
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

# install.sh reads PODIUM_INSTALL_BASE (file:// or http) + PODIUM_INSTALL_PUBKEY (override) for tests.
export PODIUM_INSTALL_BASE="file://$REL"
PODIUM_INSTALL_PUBKEY="$(cat "$WORK/pub.b64")"
export PODIUM_INSTALL_PUBKEY

echo "== plain install =="
sh "$ROOT/install.sh"
test -x "$HOME/.local/bin/podium"            || { echo FAIL: no launcher symlink; exit 1; }
test -f "$HOME/.local/share/podium/VERSION"  || { echo FAIL: bundle not installed; exit 1; }

echo "== edge install persists update channel =="
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$PODIUM_STATE_DIR"
sh "$ROOT/install.sh" --channel edge
test "$(cat "$PODIUM_STATE_DIR/update-channel" 2>/dev/null || true)" = "edge" || { echo "FAIL: edge install did not persist update channel"; exit 1; }

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
