#!/usr/bin/env bash
# Bring up the isolated `p2801` instance: server + daemon.
#
#   bash docs/evidence/pod-2801/drive-up.sh
#
# SAFE TO RE-RUN, and re-running IS how the code under test is repinned: the
# drivers and the observers are wired at the DAEMON'S process start, so editing
# a file under a running pair changes nothing at all.
#
# NO WEB BUNDLE. POD-2777's rig builds one because its verdict is about the
# product an operator opens in a browser. This rig measures ONE field of the
# session row (`agentState.phase`) over the API the board reads it from, so the
# bundle is not on the path and building it would add minutes per repin. Stated
# rather than skipped silently: if a later question is about what the board
# RENDERS rather than what it is served, this rig is the wrong instrument.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
mkdir -p "$LOGS"
export PODIUM_PASSWORD=p2801

cd "$PODIUM_DRIVE_REPO"

# A worktree with no node_modules resolves bare package names by walking UP into
# the main checkout's install, which points @podium/* at whatever branch that
# checkout is sitting on. This rig would then measure someone else's code.
bash "$HERE/link-node-modules.sh" >/dev/null

# A fresh state root reports readiness `unconfigured` and blocks the data plane.
# Claim it through the same runtime writer used by `podium setup`; the rig must
# not fabricate instance.json or config.json.
bash "$HERE/../claim-instance.sh"

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

# THE SHA IS RECORDED AT SPAWN, NOT INFERRED AFTERWARDS — /proc/<pid> mtime is
# the inode's, not the process start time, and it skews forward on this host.
start() { # name, script
  local name="$1" script="$2"
  nohup bun --conditions=@podium/source "$script" >"$LOGS/$name.log" 2>&1 &
  echo "$!" > "$PODIUM_DRIVE_BASE/$name.pid"
  git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD > "$PODIUM_DRIVE_BASE/$name.sha"
  echo "started $name pid=$(cat "$PODIUM_DRIVE_BASE/$name.pid") at $(cut -c1-7 < "$PODIUM_DRIVE_BASE/$name.sha")"
}

start server scripts/server.ts

for _ in $(seq 1 120); do
  curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 \
  || { echo "server never served /health — see $LOGS/server.log"; exit 1; }
echo "server healthy on :$PODIUM_PORT"

# AFTER the server: a named instance isolates the agent home to
# <state>/agent-home. An isolated home with no credential does not fail loudly —
# the harness starts logged out and the session sits at a login screen producing
# no output at all, which on THIS rig would read as "the phase was right to say
# idle". Auth files only.
AGENT_HOME="$PODIUM_STATE_DIR/agent-home"
mkdir -p "$AGENT_HOME/.claude" "$AGENT_HOME/.grok" "$AGENT_HOME/.codex" \
         "$AGENT_HOME/.local/share/opencode" "$AGENT_HOME/.config/opencode" \
         "$AGENT_HOME/.cursor"
chmod 700 "$AGENT_HOME"
for pair in \
  "$HOME/.claude/.credentials.json:$AGENT_HOME/.claude/.credentials.json" \
  "$HOME/.claude.json:$AGENT_HOME/.claude.json" \
  "$HOME/.codex/auth.json:$AGENT_HOME/.codex/auth.json" \
  "$HOME/.codex/config.toml:$AGENT_HOME/.codex/config.toml" \
  "$HOME/.grok/auth.json:$AGENT_HOME/.grok/auth.json" \
  "$HOME/.local/share/opencode/auth.json:$AGENT_HOME/.local/share/opencode/auth.json" \
  "$HOME/.config/opencode/opencode.jsonc:$AGENT_HOME/.config/opencode/opencode.jsonc" \
  "$HOME/.cursor/cli-config.json:$AGENT_HOME/.cursor/cli-config.json"
do
  from="${pair%%:*}"; to="${pair#*:}"
  if [ -f "$from" ] && [ ! -f "$to" ]; then cp "$from" "$to" && chmod 600 "$to"; fi
done
echo "agent home seeded at $AGENT_HOME"

( export HOME="$AGENT_HOME"; start daemon scripts/daemon.ts )

if [ ! -d "$PODIUM_DRIVE_BASE/repo/.git" ]; then
  mkdir -p "$PODIUM_DRIVE_BASE/repo"
  git -C "$PODIUM_DRIVE_BASE/repo" init -q -b main
  echo "POD-2801 phase-rig scratch repo" > "$PODIUM_DRIVE_BASE/repo/README.md"
  git -C "$PODIUM_DRIVE_BASE/repo" add README.md
  git -C "$PODIUM_DRIVE_BASE/repo" -c user.email=drive@localhost -c user.name=drive \
    commit -qm "scratch repo for the POD-2801 phase rig"
fi
echo "scratch repo at $PODIUM_DRIVE_BASE/repo"

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d '{"password":"p2801"}' >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar" \
  || { echo "login failed"; exit 1; }

echo
echo "instance '$PODIUM_INSTANCE' up"
echo "  API    http://$PODIUM_HOST:$PODIUM_PORT   (password: p2801; loopback only)"
echo "  ARM    CONTRACT=$PODIUM_RUNTIME_CONTRACT DRIVER=$PODIUM_RUNTIME_DRIVER"
echo "  repo   $PODIUM_DRIVE_REPO @ $(git -C "$PODIUM_DRIVE_REPO" rev-parse --short=7 HEAD)"
echo "  logs   $LOGS"
