#!/usr/bin/env bash
# Start/restart the p2874 daemon for the acceptance drive.
#
# Deliberately leaves HOME and all product-derived path variables alone. The
# named instance resolves its state, socket, and agent home from the normal
# environment. `shell` selects the product's documented generic-pty escape
# hatch; `claude` uses the normal driver preference.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${POD2874_REPO_ROOT:-$(cd "$HERE/../../.." && pwd)}"
BASE="${PODIUM_DRIVE_BASE:-/tmp/pod-2874}"
MODE="${1:-claude}"
INSTANCE="${POD2874_INSTANCE:-p2874}"
PASSWORD="${POD2874_PASSWORD:-$INSTANCE}"

case "$MODE" in
  claude|shell) ;;
  *) echo "usage: drive-daemon.sh claude|shell" >&2; exit 2 ;;
esac

mkdir -p "$BASE/logs"
if [[ -f "$BASE/daemon.pid" ]]; then
  old="$(<"$BASE/daemon.pid")"
  if kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$old" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$old" 2>/dev/null; then kill -9 "$old" 2>/dev/null || true; fi
  fi
fi

start_line="$(wc -l < "$BASE/logs/daemon.log" 2>/dev/null || echo 0)"
printf '=== %s daemon boot mode=%s at %s ===\n' "$INSTANCE" "$MODE" "$(date -Is)" >> "$BASE/logs/daemon.log"

cd "$REPO"
common=(env
  -u PODIUM_STATE_DIR
  -u PODIUM_AGENT_HOME
  -u ABDUCO_SOCKET_DIR
  -u TMUX_TMPDIR
  -u PODIUM_WEB_DIR
  -u PODIUM_RUNTIME_DRIVER
)
common+=(
  PODIUM_INSTANCE="$INSTANCE"
  PODIUM_DRIVE_BASE="$BASE"
  PODIUM_PASSWORD="$PASSWORD"
  PODIUM_NO_RELAY=1
  PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
)

"${common[@]}" nohup setsid bun --conditions=@podium/source scripts/daemon.ts \
  >>"$BASE/logs/daemon.log" 2>&1 < /dev/null &
pid="$!"
printf '%s\n' "$pid" > "$BASE/daemon.pid"
git rev-parse HEAD > "$BASE/daemon.sha"

for _ in $(seq 1 120); do
  if tail -n +$((start_line + 1)) "$BASE/logs/daemon.log" 2>/dev/null | \
    rg -q 'podium daemon up: connected to'; then
    printf 'daemon connected instance=%s mode=%s pid=%s sha=%s\n' "$INSTANCE" "$MODE" "$pid" "$(<"$BASE/daemon.sha")"
    exit 0
  fi
  sleep 1
done
echo "daemon did not connect; see $BASE/logs/daemon.log" >&2
exit 1
