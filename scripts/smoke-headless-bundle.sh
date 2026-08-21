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

# 2. The EMBEDDED abduco materializes and runs. This is the part cross-compilation
#    actually changed, so a bundle that starts but cannot produce a working helper is
#    the specific failure worth catching.
STATE="$WORK/state"
env -u PODIUM_ABDUCO -u PODIUM_AGENT_RELAY PODIUM_STATE_DIR="$STATE" PODIUM_HOME="$HOME_DIR" \
  "$HOME_DIR/podium" --version >/dev/null 2>&1 || true
HELPER="$STATE/bin/abduco"
[ -x "$HELPER" ] || { echo "ABORT: the bundle did not materialize an executable abduco into $STATE/bin" >&2; exit 1; }
BANNER="$("$HELPER" -v 2>&1 | head -1)" || { echo "ABORT: the embedded abduco does not run here" >&2; exit 1; }
echo "abduco -v -> $BANNER"
case "$BANNER" in
  *abduco*) : ;;
  *) echo "ABORT: the embedded abduco produced no recognisable version banner" >&2; exit 1 ;;
esac
echo "PASS: the embedded helper materializes and runs ($(file -b "$HELPER" | cut -d, -f1-2))"

# 3. The helper does its ONE job: host a session that outlives the process that started
#    it. A helper that runs but cannot detach is useless to the daemon.
export ABDUCO_SOCKET_DIR="$WORK/sockets"
mkdir -p "$ABDUCO_SOCKET_DIR"
SESSION="podium-smoke-$$"
"$HELPER" -n "$SESSION" sh -c 'sleep 60' || { echo "ABORT: the embedded abduco could not start a detached session" >&2; exit 1; }
for _ in 1 2 3 4 5 6 7 8 9 10; do
  "$HELPER" 2>&1 | grep -q "$SESSION" && break
  sleep 0.5
done
"$HELPER" 2>&1 | grep -q "$SESSION" \
  || { echo "ABORT: the detached session is absent from the helper's own session list" >&2; exit 1; }
echo "PASS: the embedded helper hosts a detached session that outlived its starter"
pkill -f "abduco.*$SESSION" 2>/dev/null || true

echo "=== BUNDLE SMOKE PASSED for $(basename "$TARBALL") ==="
