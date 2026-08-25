#!/usr/bin/env bash
# THE WHOLE MATRIX, unattended: every harness on both drivers, then the table.
#
#   bash docs/evidence/pod-2777/drive-all.sh [commit-ish]
#
# This is the fifteen minutes the brief asks for — start it and read the table
# at the end. Each ARM is a full restart of the pair, because the drivers are
# loaded at the DAEMON'S process start and flipping an env var under a running
# daemon changes nothing at all.
#
# ORDER: headless first, then terminal. Both arms run the same probes on the
# same rig against the same commit, which is what makes the columns comparable.
# claude runs ONLY in the terminal arm: it has no headless driver, and giving it
# a headless column would invent a comparison that does not exist.
#
# HOST DISCIPLINE. flatblock has fallen over repeatedly during this epic, and
# POD-2773 lost a real measurement to a session that went `reconnecting` under
# load. So: a memory floor before each arm, and the harness servers each arm
# leaves behind are reaped between harnesses rather than at the end.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIN="${1:-HEAD}"
export P2777_PIN="$PIN"

MIN_MB="${P2777_MIN_FREE_MB:-1500}"
need_memory() {
  local avail
  avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
  if [ "$avail" -lt "$MIN_MB" ]; then
    echo "HOST TOO LOADED: ${avail}MB available, floor is ${MIN_MB}MB."
    echo "Waiting rather than pushing this box over — it has fallen over before."
    return 1
  fi
  echo "host ok: ${avail}MB available"
  return 0
}

# Harness servers this rig spawned, matched ON OUR AGENT-HOME PATH and never on
# the binary name: other sessions on this box run their own opencode and grok
# servers, and a bare `pkill -f opencode` would take all of them down.
reap() {
  # Self-safe: a `pkill -f <path>` from a shell whose own command line contains
  # that path kills the shell issuing it (seen repeatedly while building this).
  ( . "$HERE/drive-env.sh"
    for pid in $(pgrep -f "$PODIUM_STATE_DIR/agent-home" 2>/dev/null || true); do
      [ "$pid" = "$$" ] && continue
      kill "$pid" 2>/dev/null || true
    done ) || true
  sleep 2
}

run_arm() { # arm-name, driver-env
  local arm="$1" driver="$2"
  echo
  echo "##################################################################"
  echo "# ARM: $arm  (PODIUM_RUNTIME_DRIVER='${driver:-}')"
  echo "##################################################################"
  need_memory || return 1

  if [ -n "$driver" ]; then export P2777_DRIVER="$driver"; else unset P2777_DRIVER; fi
  bash "$HERE/drive-up.sh" || { echo "ARM $arm: bring-up failed"; return 1; }
  bash "$HERE/drive-verify.sh" "$PIN" || { echo "ARM $arm: pin check failed"; return 1; }

  local harnesses="codex grok opencode"
  [ "$arm" = "terminal" ] && harnesses="codex grok opencode claude"

  for h in $harnesses; do
    echo
    echo "---- $h / $arm ----"
    need_memory || { echo "skipping $h/$arm: host under the floor"; continue; }
    ( . "$HERE/drive-env.sh"; bun "$HERE/drive.ts" "$h" ) 2>&1
    echo "   drive.ts exit=$?"
    reap
  done

  bash "$HERE/drive-down.sh" || true
}

run_arm headless ''
run_arm terminal 'generic-pty'

echo
echo "##################################################################"
echo "# THE TABLE"
echo "##################################################################"
( . "$HERE/drive-env.sh"; bun "$HERE/report.ts" )
echo
echo "full evidence:  bun docs/evidence/pod-2777/report.ts --evidence"
