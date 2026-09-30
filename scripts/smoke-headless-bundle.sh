#!/usr/bin/env bash
# RUN a headless bundle whose platform matches this machine, and check it works.
#
# The assertions in `assert-headless-bundle.sh` interrogate a tarball without executing
# anything, which is the only option for the three platforms a Linux runner cannot run.
# For the one it CAN run there is no excuse: a bundle that passes every static check and
# then fails to start is exactly the regression a cross-compile introduces, and the
# release job was publishing linux-x86_64 without ever having run it. (The published
# smoke does run it — after publication, which is too late to stop.)
#
# Usage: scripts/smoke-headless-bundle.sh <tarball>
set -euo pipefail

TARBALL="${1:-}"
[ -f "$TARBALL" ] || { echo "ABORT: pass the bundle to run (got '$TARBALL')" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-smoke-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

tar -xzf "$TARBALL" -C "$WORK" || { echo "ABORT: cannot extract $TARBALL" >&2; exit 1; }
HOME_DIR="$WORK/headless"
[ -x "$HOME_DIR/podium" ] || { echo "ABORT: no executable headless/podium in the bundle" >&2; exit 1; }

echo "=== running the bundle on $(uname -s)/$(uname -m) ==="

# 1. It starts, and reports the version the bundle claims.
VERSION_FILE="$(tr -d '\n' < "$HOME_DIR/VERSION")"
REPORTED="$(env -u PODIUM_AGENT_RELAY -u PODIUM_UPDATE_FEED PODIUM_HOME="$HOME_DIR" \
  "$HOME_DIR/podium" --version 2>&1)" || {
    echo "ABORT: the bundle's binary did not run: $REPORTED" >&2
    exit 1
  }
echo "podium --version -> $REPORTED"
case "$REPORTED" in
  *"$VERSION_FILE"*) : ;;
  *) echo "ABORT: binary reports '$REPORTED' but the bundle's VERSION says '$VERSION_FILE'" >&2; exit 1 ;;
esac
echo "PASS: the binary runs and agrees with the bundle's VERSION"

# 2. The bundled Rust process host runs here. It is what the daemon hosts every session
#    in (resolved from the install dir, beside podium-cli), and a daemon that finds none
#    starts no session at all, so a bundle without a working one is broken however well
#    it starts. It is a separate cross-built binary, so it can be the wrong architecture
#    or libc while podium-cli is fine.
HOST_HELPER="$HOME_DIR/podium-host-rs"
[ -x "$HOST_HELPER" ] || { echo "ABORT: no executable headless/podium-host-rs in the bundle" >&2; exit 1; }
HOST_BANNER="$("$HOST_HELPER" version 2>&1 | head -1)" || { echo "ABORT: the bundled podium-host-rs does not run here" >&2; exit 1; }
echo "podium-host-rs version -> $HOST_BANNER"
case "$HOST_BANNER" in
  "podium-host "*" features="*) : ;;
  *) echo "ABORT: the bundled podium-host-rs produced no recognisable version banner" >&2; exit 1 ;;
esac
echo "PASS: the bundled podium-host-rs runs ($(file -b "$HOST_HELPER" | cut -d, -f1-2))"

# 3. The host's one job: host a session that outlives the process that started it.
#    `create` daemonizes and returns while the host stays up; a second `create` on the
#    same socket must then refuse with exit 3 ("already running"), which proves the
#    socket is live rather than a file left behind.
HOST_SOCK="$WORK/host-$$.sock"
"$HOST_HELPER" create --socket "$HOST_SOCK" --no-pty --linger-secs 2 -- sh -c 'sleep 60' \
  || { echo "ABORT: the bundled podium-host-rs could not start a detached session" >&2; exit 1; }
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$HOST_SOCK" ] && break
  sleep 0.5
done
[ -S "$HOST_SOCK" ] || { echo "ABORT: the podium-host-rs session left no socket at $HOST_SOCK after its starter exited" >&2; exit 1; }
set +e
DUP_OUT="$("$HOST_HELPER" create --socket "$HOST_SOCK" --no-pty -- true 2>&1)"
DUP_CODE=$?
set -e
pkill -f "$HOST_SOCK" 2>/dev/null || true
[ "$DUP_CODE" = 3 ] && [[ "$DUP_OUT" == *"already running"* ]] \
  || { echo "ABORT: a second create on the live socket exited $DUP_CODE, want 3 (already running): $DUP_OUT" >&2; exit 1; }
echo "PASS: the bundled podium-host-rs hosts a detached session that outlived its starter"

echo "=== BUNDLE SMOKE PASSED for $(basename "$TARBALL") ==="
