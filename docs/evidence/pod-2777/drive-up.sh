#!/usr/bin/env bash
# Bring up the isolated `p2777` instance: server + daemon + web bundle.
#
#   bash docs/evidence/pod-2777/drive-up.sh                            # headless arm
#   P2777_DRIVER=generic-pty bash docs/evidence/pod-2777/drive-up.sh   # terminal arm
#
# Split-and-detached because that is what a real install runs, and the seam
# between server and daemon is the one every plane in this drive crosses.
#
# SAFE TO RE-RUN, and re-running IS how the arms are switched: the drivers are
# loaded at the DAEMON'S process start and the flags are read once at
# composition, so flipping an env var under a running pair changes nothing at
# all. That is the specific staleness this epic has been bitten by three times.
#
# THE WEB BUNDLE IS BUILT HERE, and unlike POD-2773's rig that is not optional.
# This drive samples the client websocket rather than a screen, so the bundle is
# not strictly a leg of the measurement — but the operator's judgement is about
# the product they open in a browser, and a drive reporting on a socket while
# the browser serves a months-old bundle is reporting on a different product
# than the one they would click. drive-verify.sh therefore pins all three
# components, and the bundle's `podium-build.json` sourceSha is how.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

LOGS="$PODIUM_DRIVE_BASE/logs"
mkdir -p "$LOGS"
export PODIUM_PASSWORD=p2777

cd "$PODIUM_DRIVE_REPO"

# --- resolve @podium/* to THIS worktree ------------------------------------
# A worktree with no node_modules resolves bare package names by walking UP the
# filesystem, into the main checkout's install — which points @podium/* at that
# checkout's packages, on whatever branch it happens to be sitting. The first
# run of this drive bundled a different branch's client-core that way and failed
# on three exports. Failing was the lucky outcome; succeeding would have
# produced a dist certified with OUR commit and built from someone else's code.
bash "$HERE/link-node-modules.sh" >/dev/null

# --- the web bundle, built to match the checkout ---------------------------
# `bun run build` in apps/web ends in write-web-build-stamp.ts, which writes
# podium-build.json carrying the checkout's sourceSha. That file is the ONLY
# first-class identity a built dist has, and it is what the third leg of the pin
# reads back OUT OF THE SERVER — proving the bundle being served is this commit,
# not merely that some dist exists on disk.
#
# Rebuilt only when the stamp does not already name HEAD: a vite build is
# minutes on a loaded box, and this rig is meant to be re-run per arm.
WANT_SHORT="$(git -C "$PODIUM_DRIVE_REPO" rev-parse --short=7 HEAD)"
STAMP="$PODIUM_DRIVE_REPO/apps/web/dist/podium-build.json"
HAVE_SHORT="$(sed -n 's/.*"sourceSha": *"\([^"]*\)".*/\1/p' "$STAMP" 2>/dev/null || true)"
if [ "$HAVE_SHORT" = "$WANT_SHORT" ]; then
  echo "web bundle already at $WANT_SHORT (skipping build)"
else
  echo "web bundle is at '${HAVE_SHORT:-none}', want $WANT_SHORT — building (this is the slow step)…"
  # `build:dist` AND NOT `build`, on purpose, and the difference is recorded
  # rather than hidden. `build` is build:dist followed by web-bundle-budget.ts
  # --check, a SIZE budget; on this branch that check fails today at 7,810,696
  # eager parsed bytes against a 7,780,000 ceiling — a pre-existing overage that
  # has nothing to do with this drive and does not change a byte of the artifact.
  # build:dist is the step that produces the dist AND writes podium-build.json,
  # so it is the step whose success this rig actually depends on. The budget is
  # then run anyway, and its verdict printed, because silently dropping a check
  # is how a rig starts lying.
  ( cd "$PODIUM_DRIVE_REPO/apps/web" && bun run build:dist ) >"$LOGS/web-build.log" 2>&1 \
    || { echo "web build FAILED — see $LOGS/web-build.log"; tail -20 "$LOGS/web-build.log"; exit 1; }
  echo "web bundle built at $WANT_SHORT"
  if ( cd "$PODIUM_DRIVE_REPO/apps/web" && bun ../../scripts/web-bundle-budget.ts dist --check ) \
       >"$LOGS/web-budget.log" 2>&1; then
    echo "  bundle-size budget: ok"
  else
    echo "  bundle-size budget: OVER (pre-existing on this branch; see $LOGS/web-budget.log)"
    echo "  $(grep -o 'eager parsed source bytes:.*' "$LOGS/web-budget.log" | head -1)"
    echo "  This is a size ceiling, not a correctness failure: the dist is complete and"
    echo "  stamped with this commit, which is what the pin check reads."
  fi
fi
export PODIUM_WEB_DIR="$PODIUM_DRIVE_REPO/apps/web/dist"

# --- first-run configuration ----------------------------------------------
# A fresh state root reports readiness `unconfigured` and BLOCKS the data plane,
# so /auth/login answers 503 and nothing can be driven. The wizard's writes go
# through tRPC, which sits behind the very guard that is blocking, so a rig with
# no operator to click it writes the one field readiness reads.
#
# THE MARKER COMES FIRST, and the order is not cosmetic. A NAMED instance
# refuses to adopt a state root that is non-empty but unmarked, so writing the
# config before anything has claimed the root makes the root non-empty and the
# very next boot dies with "refusing to adopt non-empty state directory".
if [ ! -f "$PODIUM_STATE_DIR/instance.json" ]; then
  printf '{\n  "version": 1,\n  "instanceId": "%s"\n}\n' "$PODIUM_INSTANCE" \
    > "$PODIUM_STATE_DIR/instance.json"
  chmod 600 "$PODIUM_STATE_DIR/instance.json"
  echo "claimed the state root for instance '$PODIUM_INSTANCE'"
fi
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

# THE SHA IS RECORDED AT SPAWN, NOT INFERRED AFTERWARDS.
#
# The first version of the pin asked whether a process STARTED AFTER the commit
# was made, reading `stat -c %Y /proc/<pid>`. POD-2775's reviewer defeated that
# and the defeat reproduces here: `/proc/<pid>` mtime is the INODE's mtime, not
# the process start time, and on this host 113 of 256 pids skew FORWARD by more
# than 5 seconds — worst case 7751 seconds. Worse, even with a perfect clock the
# test `started >= committed` also passes for the commit's PARENT, so it cannot
# make the one distinction a pin exists to make.
#
# So the spawning shell writes down the commit it is spawning, and verify
# compares THAT. A recorded fact beats a derived one, and it takes the timestamp
# out of the argument entirely — the same shape that makes leg 3 (fetching
# podium-build.json back out of the server) trustworthy.
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

# --- provider credentials -------------------------------------------------
# AFTER the server: a named instance isolates the agent home to
# <state>/agent-home, and the first process to boot refuses a state root that is
# non-empty but unmarked. AUTH FILES ONLY.
#
# THIS IS LOAD-BEARING, NOT HOUSEKEEPING. An isolated home with no credential
# for a harness does not fail loudly — the server driver declines and the
# session degrades to a generic PTY, which is a PERFECT false negative for a
# drive whose whole subject is headless-vs-terminal. drive.ts refuses any probe
# whose session did not bind the driver its arm asked for, for this reason.
AGENT_HOME="$PODIUM_STATE_DIR/agent-home"
mkdir -p "$AGENT_HOME/.claude" "$AGENT_HOME/.grok" "$AGENT_HOME/.codex" \
         "$AGENT_HOME/.local/share/opencode" "$AGENT_HOME/.config/opencode"
chmod 700 "$AGENT_HOME"
for pair in \
  "$HOME/.claude/.credentials.json:$AGENT_HOME/.claude/.credentials.json" \
  "$HOME/.claude.json:$AGENT_HOME/.claude.json" \
  "$HOME/.codex/auth.json:$AGENT_HOME/.codex/auth.json" \
  "$HOME/.codex/config.toml:$AGENT_HOME/.codex/config.toml" \
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
  echo "POD-2777 acceptance-drive scratch repo" > "$PODIUM_DRIVE_BASE/repo/README.md"
  git -C "$PODIUM_DRIVE_BASE/repo" add README.md
  git -C "$PODIUM_DRIVE_BASE/repo" -c user.email=drive@localhost -c user.name=drive \
    commit -qm "scratch repo for the POD-2777 acceptance drive"
fi
echo "scratch repo at $PODIUM_DRIVE_BASE/repo"

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d '{"password":"p2777"}' >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar" \
  || { echo "login failed"; exit 1; }

# --- WHICH BINARY IS EACH HARNESS, recorded rather than assumed ------------
# The daemon runs whatever its PATH resolves, and this box has two codex
# installs whose versions straddle the app-server driver's supported range. A
# drive that does not write down which binary it used cannot tell a product
# finding from a PATH accident — this rig spent an arm learning that. The
# versions go in the log beside the arm, so the answer is in the evidence.
echo "harness binaries this arm will run:"
for h in codex grok opencode claude; do
  bin="$(command -v "$h" 2>/dev/null || true)"
  if [ -n "$bin" ]; then
    ver="$("$h" --version 2>&1 | grep -v WARNING | head -1 | tr -d '\r')"
    printf '  %-9s %-40s %s\n' "$h" "$bin" "$ver"
  else
    printf '  %-9s %s\n' "$h" "NOT ON PATH — its sessions will degrade to a PTY"
  fi
done | tee "$PODIUM_DRIVE_BASE/harness-versions.txt"

echo
echo "instance '$PODIUM_INSTANCE' up"
echo "  API      http://$PODIUM_HOST:$PODIUM_PORT   (password: p2777; loopback only)"
echo "  ARM      CONTRACT=$PODIUM_RUNTIME_CONTRACT STREAMING=$PODIUM_CHAT_STREAMING DRIVER=${PODIUM_RUNTIME_DRIVER:-(policy)}"
echo "  web      $PODIUM_WEB_DIR"
echo "  state    $PODIUM_STATE_DIR"
echo "  logs     $LOGS"
