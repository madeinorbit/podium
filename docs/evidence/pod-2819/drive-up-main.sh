#!/usr/bin/env bash
# Bring up the MAIN BASELINE instance `p2819`: server + daemon + web bundle.
#
#   bash docs/evidence/pod-2819/drive-up-main.sh
#
# POD-2777's drive-up.sh with three differences, each forced by the fact that
# the code under test is main rather than the epic:
#
#   1. It sources drive-env-main.sh (different instance, root and port).
#   2. It links node_modules WITHOUT the rig's script, which does not exist on
#      main — same shape, per-entry symlinks with @podium/* repointed at this
#      worktree, for the same reason: a worktree with no node_modules resolves
#      bare names by walking UP into whatever branch the main checkout is on.
#   3. There is no arm to print. main has no runtime contract.
#
# The spawn-time SHA recording is kept verbatim: the pin has to be a fact the
# spawning shell wrote down, not one derived afterwards from /proc timestamps.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env-main.sh
. "$HERE/drive-env-main.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
mkdir -p "$LOGS"
export PODIUM_PASSWORD=p2819
REPO="$PODIUM_DRIVE_REPO"
SHARED=/home/mgw/src/podium

[ -e "$REPO/.git" ] || { echo "no worktree at $REPO"; exit 1; }

# --- resolve @podium/* to THIS worktree ------------------------------------
if [ ! -e "$REPO/node_modules/@podium/client-core" ] \
   || [ "$(readlink -f "$REPO/node_modules/@podium/client-core")" != "$(readlink -f "$REPO/packages/client-core")" ]; then
  mkdir -p "$REPO/node_modules"
  for entry in "$SHARED"/node_modules/*; do
    name="$(basename "$entry")"
    [ "$name" = "@podium" ] && continue
    [ "$name" = ".bin" ] && continue
    [ -e "$REPO/node_modules/$name" ] && continue
    ln -s "$entry" "$REPO/node_modules/$name"
  done
  for entry in "$SHARED"/node_modules/@*; do
    name="$(basename "$entry")"
    [ "$name" = "@podium" ] && continue
    [ -e "$REPO/node_modules/$name" ] && continue
    ln -s "$entry" "$REPO/node_modules/$name"
  done
  mkdir -p "$REPO/node_modules/.bin"
  for bin in "$SHARED"/node_modules/.bin/*; do
    name="$(basename "$bin")"
    [ -e "$REPO/node_modules/.bin/$name" ] && continue
    ln -s "$bin" "$REPO/node_modules/.bin/$name"
  done
  mkdir -p "$REPO/node_modules/@podium"
  for pkg in "$REPO"/packages/* "$REPO"/apps/*; do
    [ -f "$pkg/package.json" ] || continue
    name="$(sed -n 's/.*"name": *"@podium\/\([^"]*\)".*/\1/p' "$pkg/package.json" | head -1)"
    [ -n "$name" ] || continue
    rm -rf "$REPO/node_modules/@podium/$name"
    ln -s "$pkg" "$REPO/node_modules/@podium/$name"
  done
  echo "node_modules points @podium at $REPO"
fi

# --- the web bundle, built to match the checkout ---------------------------
WANT_SHORT="$(git -C "$REPO" rev-parse --short=7 HEAD)"
STAMP="$REPO/apps/web/dist/podium-build.json"
HAVE_SHORT="$(sed -n 's/.*"sourceSha": *"\([^"]*\)".*/\1/p' "$STAMP" 2>/dev/null || true)"
if [ "$HAVE_SHORT" = "$WANT_SHORT" ]; then
  echo "web bundle already at $WANT_SHORT (skipping build)"
else
  echo "web bundle is at '${HAVE_SHORT:-none}', want $WANT_SHORT — building…"
  ( cd "$REPO/apps/web" && bun run build:dist ) >"$LOGS/web-build.log" 2>&1 \
    || { echo "web build FAILED — see $LOGS/web-build.log"; tail -20 "$LOGS/web-build.log"; exit 1; }
  echo "web bundle built at $WANT_SHORT"
fi
export PODIUM_WEB_DIR="$REPO/apps/web/dist"

if [ ! -f "$PODIUM_STATE_DIR/instance.json" ]; then
  printf '{\n  "version": 1,\n  "instanceId": "%s"\n}\n' "$PODIUM_INSTANCE" \
    > "$PODIUM_STATE_DIR/instance.json"
  chmod 600 "$PODIUM_STATE_DIR/instance.json"
fi
if [ ! -f "$PODIUM_STATE_DIR/config.json" ]; then
  printf '{"configVersion":2,"mode":"all-in-one"}\n' > "$PODIUM_STATE_DIR/config.json"
fi

for name in daemon server; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$(cat "$pidfile")" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$(cat "$pidfile")" 2>/dev/null || true
  fi
  rm -f "$pidfile"
done

start() {
  local name="$1" script="$2"
  nohup bun --conditions=@podium/source "$script" >"$LOGS/$name.log" 2>&1 &
  echo "$!" > "$PODIUM_DRIVE_BASE/$name.pid"
  git -C "$REPO" rev-parse HEAD > "$PODIUM_DRIVE_BASE/$name.sha"
  echo "started $name pid=$(cat "$PODIUM_DRIVE_BASE/$name.pid") at $(cut -c1-7 < "$PODIUM_DRIVE_BASE/$name.sha")"
}

cd "$REPO"
start server scripts/server.ts
for _ in $(seq 1 120); do
  curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null 2>&1 \
  || { echo "server never served /health — see $LOGS/server.log"; exit 1; }
echo "server healthy on :$PODIUM_PORT"

# THE SAME AGENT HOME SEEDING AS THE RIG, and for the same reason: an isolated
# home with no credential does not fail loudly, it degrades.
AGENT_HOME="$PODIUM_STATE_DIR/agent-home"
mkdir -p "$AGENT_HOME/.claude" "$AGENT_HOME/.codex"
chmod 700 "$AGENT_HOME"
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

( export HOME="$AGENT_HOME"; start daemon scripts/daemon.ts )

if [ ! -d "$PODIUM_DRIVE_BASE/repo/.git" ]; then
  mkdir -p "$PODIUM_DRIVE_BASE/repo"
  git -C "$PODIUM_DRIVE_BASE/repo" init -q -b main
  echo "POD-2819 main-baseline scratch repo" > "$PODIUM_DRIVE_BASE/repo/README.md"
  git -C "$PODIUM_DRIVE_BASE/repo" add README.md
  git -C "$PODIUM_DRIVE_BASE/repo" -c user.email=drive@localhost -c user.name=drive \
    commit -qm "scratch repo for the POD-2819 main baseline"
fi

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d '{"password":"p2819"}' >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar" \
  || { echo "login failed"; exit 1; }

echo
echo "instance '$PODIUM_INSTANCE' up on main $(git -C "$REPO" rev-parse --short=7 HEAD)"
echo "  API      http://$PODIUM_HOST:$PODIUM_PORT   (password: p2819; loopback only)"
echo "  state    $PODIUM_STATE_DIR"
echo "  logs     $LOGS"
