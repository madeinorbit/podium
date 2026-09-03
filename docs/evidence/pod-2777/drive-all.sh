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
# REAP BY IDENTITY, NEVER BY COMMAND-LINE SUBSTRING — and this one KILLS what it
# matches, which is why it is the worst place on the rig to get it wrong.
#
# It used to be `pgrep -f "$P2777_STATE_ROOT/agent-home"`, and the honest account
# of that is narrower than my first one.
#
# MEASURED: that pattern is an ABSOLUTE PATH UNIQUE TO THIS INSTANCE, and it
# matches exactly one agent process — this rig's own. Other sessions carry the
# whole developer-instructions prompt in their command lines, but that blob does
# not contain this instance's agent-home path, so the reap would not have hit a
# neighbour. I first claimed it would; I had generalised from a DIFFERENT
# pattern's false positives (a generic `pod-2777/…` string, which does match
# every agent on the box) to this one, which does not.
#
# It is changed anyway, for two reasons that survive the correction:
#   - matching an absolute path in a command line is fragile BY CONSTRUCTION. It
#     happened to be safe here; nothing made it safe. Rename the instance to
#     something a prompt might mention and it stops being.
#   - the real victim was ITSELF. The self-skip `[ "$pid" = "$$" ]` is wrong
#     inside a `( … )` subshell, where `$$` is the PARENT's pid — so the loop
#     could kill the very subshell running it, mid-reap, leaving the teardown
#     half-done and looking like it had finished.
#
# The self-skip was also wrong: `$$` inside a `( … )` subshell is the PARENT's
# pid in bash, so the guard did not protect the shell it was written for.
#
# Identity is the environment, which a process cannot borrow from a prompt: the
# instance the product itself exports, AND the agent home the child was spawned
# with. Both must match. drive-down.sh has always reaped this way; this function
# had not caught up.
reap() {
  ( . "$HERE/drive-env.sh"
    me=$$
    for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
      [ "$pid" = "$me" ] && continue
      env_of="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)"
      [ -n "$env_of" ] || continue
      inst="$(printf '%s' "$env_of" | sed -n 's/^PODIUM_INSTANCE=//p' | tail -1)"
      home="$(printf '%s' "$env_of" | sed -n 's/^HOME=//p' | tail -1)"
      [ "$inst" = "$PODIUM_INSTANCE" ] || continue
      [ "$home" = "$P2777_STATE_ROOT/agent-home" ] || continue
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
