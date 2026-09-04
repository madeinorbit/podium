#!/usr/bin/env bash
# Bring up the isolated `p2853` named instance: server + daemon, split, detached.
#
#   bash docs/evidence/pod-2853/drive-up.sh
#
# Split-and-detached because that is what a real install runs. SAFE TO RE-RUN.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
# shellcheck source=drive-lib.sh
. "$HERE/drive-lib.sh"

mkdir -p "$PODIUM_DRIVE_BASE/logs"
export PODIUM_PASSWORD=p2853

# --- first-run configuration ----------------------------------------------
# The default arm uses the product-derived root and claims it through the same
# runtime writer as `podium setup`. The optional override arms are deliberately
# POD-2853's own controls for reaching the second defect beneath the path
# failure, so the no-override guard is skipped only when one is selected.
if [ -n "${P2853_ABDUCO_SOCKET_DIR:-}" ] || [ -n "${P2853_AGENT_HOME:-}" ]; then
  [ -z "${PODIUM_RIG_INHERITED_PATH_OVERRIDES:-}" ] || {
    echo "refusing POD-2853 override arm: inherited product path override(s) were present: $PODIUM_RIG_INHERITED_PATH_OVERRIDES" >&2
    exit 2
  }
  echo "known POD-2853 override arm: retaining its explicit path override"
else
  ( cd "$PODIUM_DRIVE_REPO" && bun --conditions=@podium/source "$HERE/../state-root-check.ts" )
fi
bash "$HERE/../claim-instance.sh"

p2853_stop daemon
p2853_stop server

p2853_start server
p2853_wait_server
echo "server healthy on :$PODIUM_PORT"

# --- provider credentials -------------------------------------------------
# LOAD-BEARING, NOT HOUSEKEEPING. A hermetic home with no claude credential
# reads as logged-out and the CLI parks on a login screen — which on THIS drive
# would still produce a live PTY, but a login screen is not the agent and the
# arm should be read on the real harness.
AGENT_HOME="$(p2853_agent_home)"
mkdir -p "$AGENT_HOME/.claude"
chmod 700 "$AGENT_HOME"
for pair in \
  "$HOME/.claude/.credentials.json:$AGENT_HOME/.claude/.credentials.json" \
  "$HOME/.claude.json:$AGENT_HOME/.claude.json"
do
  from="${pair%%:*}"; to="${pair#*:}"
  if [ -f "$from" ] && [ ! -f "$to" ]; then cp "$from" "$to" && chmod 600 "$to"; fi
done
echo "agent home seeded at $AGENT_HOME"

# --- the modal wizards, pre-answered --------------------------------------
# Both eat typed input and both fire only in a home that has never seen this
# cwd. This drive reads a SPAWN, not a send, so neither can forge its verdict —
# but a claude parked on a wizard is not the harness running, and the arm is
# read on whether the agent came up.
SETTINGS="$AGENT_HOME/.claude/settings.json"
if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<'SJSON'
{
  "permissions": { "defaultMode": "auto" },
  "autoMode": {
    "environment": [
      "### Rig",
      "- Isolated POD-2853 named-instance spawn drive; scratch git repo, loopback only.",
      "- Seeded so /auto-mode-setup never opens: a modal wizard swallows typed prompts."
    ]
  }
}
SJSON
  chmod 600 "$SETTINGS"
  echo "seeded $SETTINGS so /auto-mode-setup never opens"
fi

CLAUDE_JSON="$AGENT_HOME/.claude.json"
REPO_DIR="$PODIUM_DRIVE_BASE/repo"
if [ -f "$CLAUDE_JSON" ]; then
  CLAUDE_JSON_PATH="$CLAUDE_JSON" REPO_DIR="$REPO_DIR" bun -e '
    const fs = require("node:fs")
    const f = process.env.CLAUDE_JSON_PATH
    const j = JSON.parse(fs.readFileSync(f, "utf8"))
    j.projects ??= {}
    j.projects[process.env.REPO_DIR] ??= {}
    j.projects[process.env.REPO_DIR].hasTrustDialogAccepted = true
    fs.writeFileSync(f, JSON.stringify(j, null, 2))
  ' 2>/dev/null && echo "pre-accepted the folder-trust dialog for $REPO_DIR" \
    || echo "WARNING: could not pre-accept the trust dialog"
fi

p2853_start daemon
p2853_wait_daemon

if [ ! -d "$PODIUM_DRIVE_BASE/repo/.git" ]; then
  mkdir -p "$PODIUM_DRIVE_BASE/repo"
  git -C "$PODIUM_DRIVE_BASE/repo" init -q -b main
  echo "POD-2853 named-instance spawn drive scratch repo" > "$PODIUM_DRIVE_BASE/repo/README.md"
  git -C "$PODIUM_DRIVE_BASE/repo" add README.md
  git -C "$PODIUM_DRIVE_BASE/repo" -c user.email=drive@localhost -c user.name=drive \
    commit -qm "scratch repo for the POD-2853 drive"
fi
echo "scratch repo at $PODIUM_DRIVE_BASE/repo"

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d '{"password":"p2853"}' >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar" \
  || { echo "login failed"; exit 1; }

echo
echo "instance '$PODIUM_INSTANCE' up"
echo "  API      http://$PODIUM_HOST:$PODIUM_PORT   (password: p2853; loopback only)"
echo "  state    $P2853_STATE_ROOT"
echo "  arm      $PODIUM_DRIVE_REPO"
echo "  ABDUCO_SOCKET_DIR  ${ABDUCO_SOCKET_DIR:-<unset — the instance must compose its own>}"
echo "  logs     $PODIUM_DRIVE_BASE/logs"
