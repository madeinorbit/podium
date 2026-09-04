#!/usr/bin/env bash
# Bring up the isolated `p2290` instance: server + daemon, split, detached.
#
#   bash docs/evidence/pod-2290/drive-up.sh
#
# POD-2245's op-up.sh re-cut for this issue. Same topology and the same
# reasons: split-and-detached is what a real install runs, and the seam between
# server and daemon is exactly the one a driver-family fix has to survive.
#
# SAFE TO RE-RUN. It never clobbers credentials or the scratch repo, and the
# whole point of re-running is to restart the pair against edited source.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
mkdir -p "$LOGS"

export PODIUM_PASSWORD=p2290

cd "$PODIUM_DRIVE_REPO"

# The runtime setup writer claims the named state root before the first server
# boot and creates the minimal host config without fabricating instance.json.
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
  rm -f "$pidfile"
done

# SCRUB THE HARNESS'S OWN CONTROL VARIABLES (POD-2086 F5, still real): a daemon
# started from inside a Claude Code session passes these to every claude it
# spawns, the child stops saving its transcript, and since the transcript IS
# Podium's state channel for claude the session reports `idle` forever.
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH

# THE WEB BUNDLE IS THE ARTEFACT UNDER TEST. apps/server serves
# apps/web/dist, so a drive against a stale (or absent) bundle would be a
# drive against someone else's code. Rebuild unless --no-web says the caller
# just did.
# `build:dist`, not `build`: the latter chains the bundle-BUDGET check, which
# is red on the epic branch for reasons that have nothing to do with this
# instance (eager and settings chunks are over their ceilings at the tip). A
# budget gate refusing to produce a bundle would stop the drive over a number,
# so the drive builds the artefact and leaves the ceiling to its own lane.
if [ "${1:-}" != "--no-web" ]; then
  echo "building the web bundle (apps/web/dist) …"
  ( cd apps/web && bun run build:dist >"$LOGS/web-build.log" 2>&1 ) \
    || { echo "web build failed — see $LOGS/web-build.log"; exit 1; }
  echo "web bundle built"
fi

start() { # name, script
  local name="$1" script="$2"
  nohup bun --conditions=@podium/source "$script" \
    >"$LOGS/$name.log" 2>&1 &
  echo "$!" > "$PODIUM_DRIVE_BASE/$name.pid"
  echo "started $name pid=$(cat "$PODIUM_DRIVE_BASE/$name.pid")"
}

start server scripts/server.ts

for _ in $(seq 1 120); do
  if curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 \
  || { echo "server never served /health — see $LOGS/server.log"; exit 1; }
echo "server healthy on :$PODIUM_PORT"

# --- provider credentials -------------------------------------------------
# AFTER the server, and the order is not incidental: a named instance isolates
# the agent home to <state>/agent-home, and the first process to boot refuses a
# state root that is non-empty but unmarked. Auth files ONLY — no history, no
# config, no projects.
AGENT_HOME="$PODIUM_RIG_STATE_ROOT/agent-home"
mkdir -p "$AGENT_HOME/.claude" "$AGENT_HOME/.local/share/opencode" \
         "$AGENT_HOME/.codex" "$AGENT_HOME/.grok"
chmod 700 "$AGENT_HOME"
for pair in \
  "$HOME/.claude/.credentials.json:$AGENT_HOME/.claude/.credentials.json" \
  "$HOME/.claude.json:$AGENT_HOME/.claude.json" \
  "$HOME/.local/share/opencode/auth.json:$AGENT_HOME/.local/share/opencode/auth.json" \
  "$HOME/.codex/auth.json:$AGENT_HOME/.codex/auth.json" \
  "$HOME/.grok/auth.json:$AGENT_HOME/.grok/auth.json"
do
  from="${pair%%:*}"; to="${pair#*:}"
  if [ -f "$from" ] && [ ! -f "$to" ]; then cp "$from" "$to" && chmod 600 "$to"; fi
done
echo "agent home seeded at $AGENT_HOME"

# DAEMON UNDER THE ISOLATED HOME: driver children get ctx.homeDir explicitly
# since POD-2247, but DAEMON-side writes (grok hook installs at boot, opencode
# probe caches) still follow the daemon's own $HOME and belong here too.
start daemon scripts/daemon.ts

if [ ! -d "$PODIUM_DRIVE_BASE/repo/.git" ]; then
  mkdir -p "$PODIUM_DRIVE_BASE/repo"
  git -C "$PODIUM_DRIVE_BASE/repo" init -q -b main
  echo "POD-2290 view test-drive scratch repo" > "$PODIUM_DRIVE_BASE/repo/README.md"
  git -C "$PODIUM_DRIVE_BASE/repo" add README.md
  git -C "$PODIUM_DRIVE_BASE/repo" -c user.email=drive@localhost -c user.name=drive \
    commit -qm "scratch repo for the POD-2290 view drive"
fi
echo "scratch repo at $PODIUM_DRIVE_BASE/repo"

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' \
  -d '{"password":"p2290"}' >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar" \
  || echo "WARN: login for cookie failed"

echo
echo "instance '$PODIUM_INSTANCE' up"
echo "  web/API  http://$PODIUM_HOST:$PODIUM_PORT   (password: p2290; loopback only)"
echo "  state    $PODIUM_RIG_STATE_ROOT"
echo "  logs     $LOGS"
