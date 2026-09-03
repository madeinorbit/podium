#!/usr/bin/env bash
# scripts/install-sh.test.sh — runs install.sh against a local fixture "release".
#
# SCOPE [POD-3274]: install.sh is a bootstrap. It gets a signature-verified binary onto disk and
# hands control to `podium install-finish`. So this file tests exactly that contract — platform
# selection, prerequisite refusal, fail-closed verification, atomic install, independent
# instance roots, and the handoff itself.
#
# Everything AFTER the handoff — PATH persistence, the supervision probe, agent installs,
# pairing, the closing report — is the binary's, and is tested against the real implementation
# in apps/cli/src/install-{path,supervision,agents,finish}.test.ts. Asserting it here would
# only assert the behaviour of the stub below.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"
export PODIUM_STATE_DIR="$HOME/.podium"

# --- build a fake signed release into $WORK/release ---
REL="$WORK/release"; mkdir -p "$REL/headless"
# Build the packaged unit artifacts into the local release fixture. The installer consumes these
# files exactly as it consumes a locally built headless tarball.
bun --conditions=@podium/source "$ROOT/scripts/render-systemd.ts" \
  --profile packaged --output "$REL/headless/systemd" >/dev/null
# Stub binary. It answers `--version` (the probe install.sh gates the handoff on) and logs the
# `install-finish` argv, which IS the contract under test. It deliberately implements nothing
# else: what install-finish does with those flags is covered by its own TypeScript tests.
cat > "$REL/headless/podium" <<'SH'
#!/bin/sh
instance="${PODIUM_INSTANCE:-default}"
[ -n "${PODIUM_STUB_LOG:-}" ] && echo "stub-instance $instance $*" >> "$PODIUM_STUB_LOG"
case "$1" in
  --version)
    [ -z "${PODIUM_STUB_UNRUNNABLE:-}" ] || exit 126
    echo "podium 9.9.9"
    ;;
  install-finish)
    if [ -n "${PODIUM_STUB_LOG:-}" ]; then
      echo "stub-finish $*" >> "$PODIUM_STUB_LOG"
      echo "stub-finish-token ${PODIUM_JOIN_TOKEN:-<none>}" >> "$PODIUM_STUB_LOG"
      # Proves whether the handoff reconnected a terminal (the `< /dev/tty` redirect).
      if [ -t 0 ]; then echo "stub-finish-stdin tty" >> "$PODIUM_STUB_LOG"
      else echo "stub-finish-stdin not-a-tty" >> "$PODIUM_STUB_LOG"; fi
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

LOG="$WORK/stub.log"
run_install() { rm -f "$LOG"; env PODIUM_STUB_LOG="$LOG" sh "$ROOT/install.sh" "$@"; }
logged() { grep -F -- "$1" "$LOG" >/dev/null; }

echo "== plain install =="
run_install
test -x "$HOME/.local/bin/podium"            || { echo FAIL: no launcher symlink; exit 1; }
test -f "$HOME/.local/share/podium/VERSION"  || { echo FAIL: bundle not installed; exit 1; }

echo "== the handoff carries what only the shell knew [R2] =="
# install.sh's OWN flags are not install-finish's, so a bare "$@" forward would be wrong.
logged 'stub-finish install-finish --channel stable --instance default' \
  || { echo "FAIL: handoff did not carry channel/instance"; cat "$LOG"; exit 1; }
logged "--dest $HOME/.local/share/podium --bin $HOME/.local/bin --command podium" \
  || { echo "FAIL: handoff did not carry dest/bin/command"; cat "$LOG"; exit 1; }

echo "== the handoff happens only AFTER signature verification [R2] =="
# Ordering, not just presence: a handoff that ran before the check would be a bypass of it.
grep -n 'openssl pkeyutl -verify' "$ROOT/install.sh" >/dev/null || { echo "FAIL: no verify step"; exit 1; }
verify_line="$(grep -n 'signature verification FAILED' "$ROOT/install.sh" | head -1 | cut -d: -f1)"
exec_line="$(grep -n 'exec "\$BIN/\$COMMAND"' "$ROOT/install.sh" | head -1 | cut -d: -f1)"
test "$verify_line" -lt "$exec_line" \
  || { echo "FAIL: the exec handoff is not after signature verification"; exit 1; }

echo "== a join token travels in the ENVIRONMENT, never in argv =="
# A live pairing code in argv is readable by every other user on the box via /proc/*/cmdline.
run_install --join TESTTOKEN
logged 'stub-finish-token TESTTOKEN' || { echo "FAIL: join token not passed in the environment"; exit 1; }
if logged 'stub-finish install-finish' && grep -F 'stub-finish install-finish' "$LOG" | grep -F 'TESTTOKEN' >/dev/null; then
  echo "FAIL: join token leaked into install-finish argv"; exit 1
fi

echo "== --agents, --vps and PODIUM_NO_MODIFY_PATH reach the handoff =="
run_install --agents codex,claude-code,grok
logged '--agents codex,claude-code,grok' || { echo "FAIL: --agents not forwarded"; exit 1; }
run_install --vps
logged '--vps' || { echo "FAIL: --vps not forwarded"; exit 1; }
rm -f "$LOG"; env PODIUM_STUB_LOG="$LOG" PODIUM_NO_MODIFY_PATH=1 sh "$ROOT/install.sh" >/dev/null
logged '--no-modify-path' || { echo "FAIL: PODIUM_NO_MODIFY_PATH not forwarded"; exit 1; }

echo "== --managed and --shared are accepted and change nothing [R10] =="
# POD-3309 owns whether they should mean anything. Until then they must not break a caller.
run_install --managed >/dev/null
managed="$(grep -F 'stub-finish install-finish' "$LOG")"
run_install --shared >/dev/null
shared="$(grep -F 'stub-finish install-finish' "$LOG")"
run_install >/dev/null
plain="$(grep -F 'stub-finish install-finish' "$LOG")"
test "$managed" = "$plain" && test "$shared" = "$plain" \
  || { echo "FAIL: --managed/--shared changed the handoff"; exit 1; }

echo "== a non-tty install asks for --no-interactive rather than hanging on a prompt =="
rm -f "$LOG"
env PODIUM_STUB_LOG="$LOG" sh "$ROOT/install.sh" < /dev/null >/dev/null
logged '--no-interactive' || { echo "FAIL: no-tty install did not disable prompting"; exit 1; }

echo '== under curl | sh the handoff RECONNECTS the terminal via /dev/tty =='
# THE point of the handoff: stdin is the pipe, but /dev/tty is still the controlling terminal,
# so the binary can prompt. `script` gives this test a real pty to prove it against — without
# one the else-branch always wins and the redirect would never be exercised at all.
if command -v script >/dev/null 2>&1; then
  rm -f "$LOG"
  # stdin is a PIPE (as under curl | sh), inside a pty session.
  script -qec "echo | env PODIUM_STUB_LOG=$LOG sh $ROOT/install.sh" /dev/null >/dev/null 2>&1 || true
  logged 'stub-finish-stdin tty' \
    || { echo "FAIL: piped install did not reconnect /dev/tty for the handoff"; cat "$LOG"; exit 1; }
  logged '--no-interactive' \
    && { echo "FAIL: a reconnected terminal still asked for --no-interactive"; exit 1; }
else
  echo "   (skipped: no \`script\` to allocate a pty)"
fi

echo "== an unrunnable binary reports plainly and fails, instead of claiming success [R3] =="
# Reporting a failure is part of an installer's job, so it cannot depend on the thing that
# failed. rustup hits the same case with a noexec /tmp.
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium"
if unrunnable="$(env PODIUM_STUB_UNRUNNABLE=1 sh "$ROOT/install.sh" 2>&1)"; then
  echo "FAIL: install succeeded with a binary that cannot run"; exit 1
fi
grep -F 'could not be run' <<<"$unrunnable" >/dev/null \
  || { echo "FAIL: unrunnable binary was not reported"; exit 1; }
grep -F 'install-finish' <<<"$unrunnable" >/dev/null \
  || { echo "FAIL: the fallback report did not name the command to re-run"; exit 1; }

echo "== named install has an independent root and bound command =="
rm -rf "$HOME/.local/share/podium"; run_install >/dev/null
printf 'keep\n' > "$HOME/.local/share/podium/DEFAULT-SENTINEL"
env -u PODIUM_STATE_DIR PODIUM_STUB_LOG="$LOG" sh "$ROOT/install.sh" --instance blue
test -x "$HOME/.local/bin/podium-blue" || { echo FAIL: no named launcher; exit 1; }
test -f "$HOME/.local/share/podium-instances/blue/VERSION" || { echo FAIL: named bundle not installed; exit 1; }
test -f "$HOME/.local/share/podium/DEFAULT-SENTINEL" || { echo FAIL: named install replaced default bundle; exit 1; }
env -u PODIUM_STATE_DIR PODIUM_STUB_LOG="$LOG" "$HOME/.local/bin/podium-blue" status >/dev/null
grep -F 'stub-instance blue status' "$LOG" >/dev/null || { echo FAIL: named launcher did not bind identity; exit 1; }
grep -F -- '--instance blue' "$LOG" >/dev/null || { echo FAIL: named install did not tell the handoff its instance; exit 1; }
grep -F -- '--command podium-blue' "$LOG" >/dev/null || { echo FAIL: named install did not tell the handoff its command; exit 1; }

echo "== invalid instance ids fail before installation =="
if sh "$ROOT/install.sh" --instance Blue 2>/dev/null; then echo "FAIL: invalid instance accepted"; exit 1; fi

echo "== edge installs hand the edge channel to the binary that persists it =="
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium" "$PODIUM_STATE_DIR"
run_install --channel edge
logged '--channel edge' || { echo "FAIL: edge install did not forward the channel"; exit 1; }

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

echo "== tamper rejection [R1] =="
printf 'x' >> "$REL/podium-headless-linux-x64.tar.gz"   # corrupt after signing
rm -rf "$HOME/.local/share/podium" "$HOME/.local/bin/podium"
if sh "$ROOT/install.sh" 2>/dev/null; then echo "FAIL: tampered install succeeded"; exit 1; fi
test ! -e "$HOME/.local/share/podium" || { echo FAIL: wrote bundle despite bad sig; exit 1; }

echo "ALL OK"
