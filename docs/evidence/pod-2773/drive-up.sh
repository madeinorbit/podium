#!/usr/bin/env bash
# Bring up the isolated `p2773` instance: server + daemon, split, detached.
#
#   bash docs/evidence/pod-2773/drive-up.sh                    # treatment arm
#   P2773_CONTRACT=0 bash docs/evidence/pod-2773/drive-up.sh   # terminal-driver control
#   P2773_STREAMING=0 bash docs/evidence/pod-2773/drive-up.sh  # plane-off control
#
# Split-and-detached because that is what a real install runs, and the seam
# between server and daemon is the one the preview plane crosses.
#
# SAFE TO RE-RUN, and re-running IS how the arms are switched: the drivers are
# loaded at the DAEMON'S process start and the flags are read once at
# composition, so flipping an env var under a running pair changes nothing at
# all. That is the specific staleness this epic has been bitten by.
#
# NO WEB BUNDLE. This drive samples the client websocket — the same frames the
# browser's chat pane consumes — rather than a screen, so the bundle is not a
# leg of it. Said out loud rather than silently skipped: if you extend this to
# look at a rendered pane, build apps/web first and re-verify.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
mkdir -p "$LOGS"
export PODIUM_PASSWORD=p2773

cd "$PODIUM_DRIVE_REPO"

# --- first-run configuration ----------------------------------------------
# A fresh state root reports readiness `unconfigured` and BLOCKS the data plane,
# so /auth/login answers 503 and nothing can be driven. The wizard's writes go
# through tRPC, which sits behind the very guard that is blocking, so a rig with
# no operator to click it writes the one field readiness reads. `all-in-one` and
# not `daemon`: saveConfig refuses a daemon-mode config with no serverUrl.
if [ ! -f "$PODIUM_STATE_DIR/config.json" ]; then
  printf '{"configVersion":2,"mode":"all-in-one"}\n' > "$PODIUM_STATE_DIR/config.json"
  echo "wrote first-run config (mode=all-in-one)"
fi

# Stop a previous pair first — this script's re-run IS the restart path, and the
# arm switch depends on it.
for name in daemon server; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$(cat "$pidfile")" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$(cat "$pidfile")" 2>/dev/null || true
    echo "stopped previous $name"
  fi
  rm -f "$pidfile"
done

start() { # name, script
  local name="$1" script="$2"
  nohup bun --conditions=@podium/source "$script" >"$LOGS/$name.log" 2>&1 &
  echo "$!" > "$PODIUM_DRIVE_BASE/$name.pid"
  echo "started $name pid=$(cat "$PODIUM_DRIVE_BASE/$name.pid")"
}

start server scripts/server.ts

for _ in $(seq 1 120); do
  curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 \
  || { echo "server never served /health — see $LOGS/server.log"; exit 1; }
echo "server healthy on :$PODIUM_PORT"

# --- provider credentials -------------------------------------------------
# AFTER the server: a named instance isolates the agent home to
# <state>/agent-home, and the first process to boot refuses a state root that is
# non-empty but unmarked. AUTH FILES ONLY.
#
# THIS IS LOAD-BEARING, NOT HOUSEKEEPING. An isolated home with no opencode
# credential does not fail loudly — the server driver declines and the session
# degrades to a generic PTY, which declares no `fine` watch level and therefore
# produces exactly zero preview frames. That is a perfect false negative for
# this drive, and it is the shape POD-2761's rig hit twice. opencode's state is
# XDG-rooted under $HOME, so the isolated home needs its own copy; the 240MB
# opencode.db beside it is NOT copied, because a fresh session does not need it.
AGENT_HOME="$PODIUM_STATE_DIR/agent-home"
mkdir -p "$AGENT_HOME/.claude" "$AGENT_HOME/.grok" \
         "$AGENT_HOME/.local/share/opencode" "$AGENT_HOME/.config/opencode"
chmod 700 "$AGENT_HOME"
for pair in \
  "$HOME/.claude/.credentials.json:$AGENT_HOME/.claude/.credentials.json" \
  "$HOME/.claude.json:$AGENT_HOME/.claude.json" \
  "$HOME/.grok/auth.json:$AGENT_HOME/.grok/auth.json" \
  "$HOME/.local/share/opencode/auth.json:$AGENT_HOME/.local/share/opencode/auth.json" \
  "$HOME/.config/opencode/opencode.jsonc:$AGENT_HOME/.config/opencode/opencode.jsonc"
do
  from="${pair%%:*}"; to="${pair#*:}"
  if [ -f "$from" ] && [ ! -f "$to" ]; then cp "$from" "$to" && chmod 600 "$to"; fi
done
echo "agent home seeded at $AGENT_HOME"

# DAEMON UNDER THE ISOLATED HOME: driver children get ctx.homeDir explicitly
# since POD-2247, but daemon-side writes still follow the daemon's own $HOME.
( export HOME="$AGENT_HOME"; start daemon scripts/daemon.ts )

if [ ! -d "$PODIUM_DRIVE_BASE/repo/.git" ]; then
  mkdir -p "$PODIUM_DRIVE_BASE/repo"
  git -C "$PODIUM_DRIVE_BASE/repo" init -q -b main
  echo "POD-2773 chat-streaming test-drive scratch repo" > "$PODIUM_DRIVE_BASE/repo/README.md"
  git -C "$PODIUM_DRIVE_BASE/repo" add README.md
  git -C "$PODIUM_DRIVE_BASE/repo" -c user.email=drive@localhost -c user.name=drive \
    commit -qm "scratch repo for the POD-2773 drive"
fi
echo "scratch repo at $PODIUM_DRIVE_BASE/repo"

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d '{"password":"p2773"}' >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar" \
  || { echo "login failed"; exit 1; }

echo
echo "instance '$PODIUM_INSTANCE' up"
echo "  API      http://$PODIUM_HOST:$PODIUM_PORT   (password: p2773; loopback only)"
echo "  ARM      PODIUM_RUNTIME_CONTRACT=$PODIUM_RUNTIME_CONTRACT PODIUM_CHAT_STREAMING=$PODIUM_CHAT_STREAMING"
echo "  state    $PODIUM_STATE_DIR"
echo "  logs     $LOGS"
