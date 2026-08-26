#!/usr/bin/env bash
# Bring up the isolated `p2761` instance: server + daemon, split, detached.
#
#   bash docs/evidence/pod-2761/drive-up.sh
#
# Split-and-detached because that is what a real install runs, and the seam
# between server and daemon is the one this change has to survive.
#
# SAFE TO RE-RUN. It never clobbers credentials or the scratch repo, and the
# whole point of re-running is to restart the pair against edited source.
#
# NO WEB BUNDLE, AND THE REASON MATTERS HERE MORE THAN IT DID FOR 2753.
# This defect IS a visual one, so "no bundle" needs defending rather than noting.
# The drive attaches to the session's terminal stream over the same client
# websocket the browser uses, and replays the bytes through the same terminal
# emulator the browser renders with (@xterm/headless, the headless build of
# xterm.js). It then reads the resulting BUFFER — screen plus scrollback. That is
# a stricter reading of "is the interface drawn twice" than a screenshot, which
# shows only the viewport. What it is NOT is a human looking at a browser: that
# check belongs to the operator, and this rig exists to make it worth their time.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
mkdir -p "$LOGS"
export PODIUM_PASSWORD=p2761

cd "$PODIUM_DRIVE_REPO"

# --- first-run configuration ----------------------------------------------
# A fresh state root reports readiness `unconfigured` / `setup_required` and
# BLOCKS the data plane, so /auth/login answers 503 and nothing can be driven.
# POD-2290's script predates that gate and would hang here.
#
# The wizard's writes go through the `setup.*` tRPC procedures, which sit behind
# the same /trpc guard the gate is blocking — a chicken-and-egg the web onboarding
# screen resolves interactively. A rig has no operator to click it, so it writes
# the one field readiness actually reads (`mode`) directly. `all-in-one` and not
# `daemon`: saveConfig refuses a daemon-mode config with no serverUrl, and
# readiness compares the mode the SERVER booted with against the mode on disk,
# so the two must agree before the first request, not after it.
#
# Claim the named state root through the same runtime writer used by `podium
# setup`; the rig must not fabricate instance.json or config.json.
( cd "$PODIUM_DRIVE_REPO" && bun --conditions=@podium/source "$HERE/../state-root-check.ts" )
bash "$HERE/../claim-instance.sh"

# Stop a previous pair first — this script's re-run IS the restart path.
for name in daemon server; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$(cat "$pidfile")" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$(cat "$pidfile")" 2>/dev/null || true
    echo "stopped previous $name"
  fi
  rm -f "$pidfile" "$PODIUM_DRIVE_BASE/$name.sha"
done

start() { # name, script
  local name="$1" script="$2" running_sha
  running_sha="$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)"
  printf '%s\n' "$running_sha" > "$PODIUM_DRIVE_BASE/$name.sha"
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
# AFTER the server, and the order is not incidental: a named instance isolates
# the agent home to <state>/agent-home, and the first process to boot refuses a
# state root that is non-empty but unmarked. Auth files ONLY.
AGENT_HOME="$PODIUM_RIG_STATE_ROOT/agent-home"
mkdir -p "$AGENT_HOME/.claude" "$AGENT_HOME/.codex"
chmod 700 "$AGENT_HOME"
#
# CODEX TOO, and this is the leg whose absence made the first drive LIE.
# Seeding only claude leaves codex logged out in the isolated home, and a logged
# out harness does not degrade loudly — it resolves to `generic-pty` behind one
# warn line ("harness is logged out; terminal provides interactive login"). That
# is a session with no codex-app-server, so no client terminal, no abduco master
# and nothing that could duplicate: the drive measured an empty stream and
# called it a pass. Auth files only; no history, no state beyond credentials.
for pair in \
  "$HOME/.claude/.credentials.json:$AGENT_HOME/.claude/.credentials.json" \
  "$HOME/.claude.json:$AGENT_HOME/.claude.json" \
  "$HOME/.codex/auth.json:$AGENT_HOME/.codex/auth.json" \
  "$HOME/.codex/config.toml:$AGENT_HOME/.codex/config.toml"
do
  from="${pair%%:*}"; to="${pair#*:}"
  if [ -f "$from" ] && [ ! -f "$to" ]; then cp "$from" "$to" && chmod 600 "$to"; fi
done
echo "agent home seeded at $AGENT_HOME"

# DAEMON UNDER THE ISOLATED HOME: driver children get ctx.homeDir explicitly
# since POD-2247, but daemon-side writes still follow the daemon's own $HOME.
start daemon scripts/daemon.ts

if [ ! -d "$PODIUM_DRIVE_BASE/repo/.git" ]; then
  mkdir -p "$PODIUM_DRIVE_BASE/repo"
  git -C "$PODIUM_DRIVE_BASE/repo" init -q -b main
  echo "POD-2761 client-terminal test-drive scratch repo" > "$PODIUM_DRIVE_BASE/repo/README.md"
  git -C "$PODIUM_DRIVE_BASE/repo" add README.md
  git -C "$PODIUM_DRIVE_BASE/repo" -c user.email=drive@localhost -c user.name=drive \
    commit -qm "scratch repo for the POD-2761 drive"
fi
echo "scratch repo at $PODIUM_DRIVE_BASE/repo"

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d '{"password":"p2761"}' >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar" \
  || { echo "login failed"; exit 1; }

echo
echo "instance '$PODIUM_INSTANCE' up"
echo "  API    http://$PODIUM_HOST:$PODIUM_PORT   (password: p2761; loopback only)"
echo "  state  $PODIUM_RIG_STATE_ROOT"
echo "  logs   $LOGS"
