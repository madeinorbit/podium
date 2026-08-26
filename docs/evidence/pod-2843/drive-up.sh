#!/usr/bin/env bash
# Bring up the isolated `p2843` instance: server + daemon, split, detached.
#
#   bash docs/evidence/pod-2843/drive-up.sh
#
# Split-and-detached because that is what a real install runs, and the seam
# between server and daemon is the one this bug is reported to live on: a
# restart of EITHER half is the manoeuvre under test, and a single in-process
# pair cannot be half-restarted.
#
# SAFE TO RE-RUN. To restart only one half — which is the actual experiment —
# use drive-restart.sh, not this.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
# shellcheck source=drive-lib.sh
. "$HERE/drive-lib.sh"

mkdir -p "$PODIUM_DRIVE_BASE/logs"
export PODIUM_PASSWORD=p2843

# --- first-run configuration ----------------------------------------------
# A fresh state root reports readiness `unconfigured` and BLOCKS the data plane,
# so /auth/login answers 503 and nothing can be driven. THE MARKER COMES FIRST:
# a NAMED instance refuses to adopt a state root that is non-empty but unmarked.
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

p2843_stop daemon
p2843_stop server

p2843_start server
p2843_wait_server
echo "server healthy on :$PODIUM_PORT"

# --- provider credentials -------------------------------------------------
# AFTER the server: a named instance isolates the agent home to
# <state>/agent-home. AUTH FILES ONLY.
#
# LOAD-BEARING, NOT HOUSEKEEPING. A hermetic home with no claude credential
# reads as logged-out, the CLI parks on a login screen, and NOTHING typed at it
# ever becomes a transcript turn — which is precisely the symptom under
# investigation. An unseeded home would manufacture this bug.
AGENT_HOME="$(p2843_agent_home)"
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

# --- THE AUTO-MODE SETUP WIZARD, PRE-ANSWERED ------------------------------
# THE SECOND RIG CORRECTION, AND THE MORE DANGEROUS OF THE TWO.
#
# With auto mode on and NO ~/.claude/settings.json carrying an `autoMode`
# block, claude-code 2.1.231 runs `/auto-mode-setup` ITSELF, once per session,
# as soon as the first turn ends. It is a modal, arrow-key wizard, and it eats
# everything typed at it: the second send of every session was painted into the
# wizard, never became a user turn, and left the session reporting `idle`.
#
# That is not a first-run condition that warms away — it fires in EVERY new
# session of a home that has no autoMode settings — and it lands AFTER the
# first turn, which is what makes it lethal to a drive like this one: the
# obvious positive control ("did my first send land?") passes, and everything
# measured after it is measuring the wizard.
#
# A MINIMAL settings.json, not a copy of the developer's. The host file also
# carries enabledPlugins and a model choice that this isolated home has no
# marketplace for, and importing those would trade one rig artefact for
# another. Only the two facts the rig needs are seeded: the permission mode the
# sessions run under, and an `autoMode.environment` that already exists so
# nothing offers to build one.
SETTINGS="$AGENT_HOME/.claude/settings.json"
if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<'SJSON'
{
  "permissions": { "defaultMode": "auto" },
  "autoMode": {
    "environment": [
      "### Rig",
      "- Isolated POD-2843 test-drive instance; scratch git repo, loopback only.",
      "- Seeded so /auto-mode-setup never opens: a modal wizard swallows typed prompts."
    ]
  }
}
SJSON
  chmod 600 "$SETTINGS"
  echo "seeded $SETTINGS so /auto-mode-setup never opens"
fi

# --- THE FOLDER TRUST DIALOG, PRE-ACCEPTED ---------------------------------
# THIS IS A CORRECTION TO THE RIG, AND IT COST THE FIRST RUN OF THIS DRIVE.
#
# claude-code asks "Is this a project you created or one you trust?" the first
# time it is started in a cwd the HOME has never seen, and an isolated agent
# home has never seen anything. That dialog eats free text: the prompt the
# drain typed was painted into it, the CLI treated the Enter as the dialog's
# answer, no user turn was ever written, and the session sat idle with a queued
# row on one attempt. That is an EXACT forgery of the bug under test — "typed,
# never arrived, nothing in the transcript" — produced by a rig that had
# nothing to do with reattaching.
#
# It self-heals after one session, which is what makes it dangerous: it forges
# the bug only on the first session of a fresh state root, so a drive that
# creates one session per arm sees it once and a drive that reuses a session
# never sees it at all. Seeded here so it is never the answer again.
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
    || echo "WARNING: could not pre-accept the trust dialog; the FIRST session may eat its own prompt"
fi

p2843_start daemon
p2843_wait_daemon

if [ ! -d "$PODIUM_DRIVE_BASE/repo/.git" ]; then
  mkdir -p "$PODIUM_DRIVE_BASE/repo"
  git -C "$PODIUM_DRIVE_BASE/repo" init -q -b main
  echo "POD-2843 reattach-send test-drive scratch repo" > "$PODIUM_DRIVE_BASE/repo/README.md"
  git -C "$PODIUM_DRIVE_BASE/repo" add README.md
  git -C "$PODIUM_DRIVE_BASE/repo" -c user.email=drive@localhost -c user.name=drive \
    commit -qm "scratch repo for the POD-2843 drive"
fi
echo "scratch repo at $PODIUM_DRIVE_BASE/repo"

curl -fsS -c "$PODIUM_DRIVE_BASE/cookie-jar" \
  -X POST "http://$PODIUM_HOST:$PODIUM_PORT/auth/login" \
  -H 'content-type: application/json' -d '{"password":"p2843"}' >/dev/null \
  && echo "cookie jar at $PODIUM_DRIVE_BASE/cookie-jar" \
  || { echo "login failed"; exit 1; }

echo
echo "instance '$PODIUM_INSTANCE' up"
echo "  API      http://$PODIUM_HOST:$PODIUM_PORT   (password: p2843; loopback only)"
echo "  state    $PODIUM_STATE_DIR"
echo "  logs     $PODIUM_DRIVE_BASE/logs"
