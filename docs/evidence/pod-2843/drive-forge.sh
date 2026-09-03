#!/usr/bin/env bash
# THE FORGERY ARM — reproduce POD-2836's report from the RIG rather than from a
# reattach, by putting back the one thing the fixed rig seeds.
#
#   bash docs/evidence/pod-2843/drive-forge.sh server
#
# The claim this arm exists to test is specific: that "typed five times to the
# attempt cap, no user turn" is what a restart-forced readiness-queue send looks
# like when claude's /auto-mode-setup wizard is holding the composer, and NOT a
# defect in the readiness queue.
#
# It is a one-variable A/B against the arm that passed. Everything is identical
# to a normal run except that ~/.claude/settings.json is removed from the agent
# home first, which is the state POD-2836's rig — and this one, before it was
# corrected — was in. Restored afterwards so the next arm is clean.
#
# TWO PREDICTIONS, and the arm is only evidence if both land:
#   - send #1 lands (it precedes the wizard, which opens after the first turn);
#   - send #2 does NOT, and the durable row reaches attempts=5.
# Predicting the ATTEMPT COUNT is the part that matters. Failing to arrive is
# cheap to produce by accident; arriving at five, on the path a restart forces a
# send down, is the report's own fingerprint.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"
half="${1:-server}"

SETTINGS="$PODIUM_RIG_STATE_ROOT/agent-home/.claude/settings.json"
STASH="$PODIUM_DRIVE_BASE/settings.json.stashed"
restore() {
  if [ -f "$STASH" ]; then mv "$STASH" "$SETTINGS"; echo "restored $SETTINGS"; fi
}
trap restore EXIT
if [ -f "$SETTINGS" ]; then
  mv "$SETTINGS" "$STASH"
  echo "removed $SETTINGS — /auto-mode-setup will open after the first turn"
else
  echo "no settings.json to remove; the home is already in the forged state"
fi

# A FRESH SESSION IS REQUIRED. The wizard opens per session after that session's
# first turn, so a session that has already been through it is immune and would
# report a false pass.
PODIUM_PASSWORD=p2843 bun "$HERE/drive.ts" "$half"
