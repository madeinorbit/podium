#!/usr/bin/env bash
# Prove the running p2777 instance IS the commit you name — SERVER, DAEMON AND
# WEB BUNDLE, all three — IN THE ARM you think it is. Exits non-zero on any
# mismatch, and prints nothing a later script could mistake for a pass.
#
#   bash docs/evidence/pod-2777/drive-verify.sh <commit-ish>
#
# WHY THIS EXISTS. Stale-rig conclusions have been drawn on this epic three
# times, always the same shape: something was measured, the number was believed,
# and nobody checked that the processes producing it were running the code under
# test. Static checks on a worktree cannot answer that — the daemon is a
# long-lived bun process that read its source minutes or hours ago, and THE
# DRIVERS ARE LOADED AT ITS PROCESS START, so repinning a checkout underneath a
# running daemon changes precisely nothing.
#
# THREE COMPONENTS, NOT TWO. POD-2773's rig checked server and daemon. This one
# adds the web bundle, because a dist is built once and then silently outlives
# any number of repins: the operator's judgement is about the product in their
# browser, and a bundle from a different commit is a different product. The
# bundle's leg is read BACK OUT OF THE SERVER (`/podium-build.json`) rather than
# off disk, so what is pinned is the bytes being SERVED and not merely a file
# that happens to exist in the worktree.
#
# There is deliberately NO "is the fix loaded" probe against /proc. A JS module
# is read() and closed, never left mmapped, so /proc/<pid>/{maps,map_files,fd}
# cannot see it and a check written that way passes vacuously whether the code
# is loaded or not — POD-2753 shipped one and had to withdraw it.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

WANT="${1:?usage: drive-verify.sh <commit-ish>}"
WANT_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse "$WANT")"
WANT_SHORT="$(git -C "$PODIUM_DRIVE_REPO" rev-parse --short=7 "$WANT")"
fail() { echo "VERIFY FAILED: $*" >&2; exit 1; }

# 0. NO PROBE IS ALREADY DRIVING THIS RIG — CHECKED FIRST, BEFORE THE PIN.
#
# Asked for by POD-1761 after the pgrep-f trap: turn the finding into a guard
# rather than a message.
#
# FIRST, ahead of the pin legs, and the order is deliberate. A concurrent probe
# invalidates every reading the run would take, whatever the pin says — so it is
# both the cheapest check and the one whose failure matters most. Behind the pin
# legs it was also untestable on a stale rig: leg 1 refused first and this never
# ran. Two probes against one instance interleave their
# sessions and their output, and the readings are unattributable afterwards —
# the same collision two RIGS have, one level down.
#
# Identity plus location: `bun` by executable, then the working directory. Never
# a command-line substring. MEASURED on this box at 2026-08-26 18:42 CEST: of 43
# live agent processes, a generic project substring ('docs/evidence') matches SIX
# — other sessions' agents, because every Podium agent carries its whole prompt in
# argv — plus the grepping shell itself, whose command line contains the pattern
# by construction. Not "every agent", which is what I first wrote; 6 of 43 is the
# real number and it is quite bad enough for something wired to a kill.
#
# The converse is worth recording next to it, because I got it wrong in the loud
# direction: a substring that is an ABSOLUTE PATH UNIQUE TO THIS INSTANCE matches
# only this rig's own processes — other sessions' prompts do not contain it. So
# `pgrep -f` is not uniformly unsafe; it is unsafe WHEN THE PATTERN IS GENERIC,
# and the fix is to stop matching on argv text at all rather than to hunt for a
# pattern specific enough to get away with.
#
# MUTATION-CHECKED 2026-08-26 18:45 CEST, both directions, against processes
# whose liveness was proved first:
#   baseline, nothing driving          -> detects nothing
#   a bun probe run from the repo cwd  -> DETECTED  (positive control fires)
#   a bun process named scripts/daemon -> skipped   (negative control holds)
# The first attempt at this test was VACUOUS and nearly banked: `bun` was not on
# PATH, exec failed, no process ever started, and both arms dutifully reported
# ''— which reads as "the skip works" if you only look at the negative arm. The
# fix that matters is not the PATH, it is that the check now prints each pid's
# /proc/<pid>/exe before drawing any conclusion, so an arm that tested nothing
# cannot look like an arm that passed.
DRIVING=""
for pid in $(pgrep -x bun 2>/dev/null || true); do
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [ "$cwd" = "$PODIUM_DRIVE_REPO" ] || continue
  argv1="$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | sed -n '2p')"
  case "$argv1" in
    *scripts/server.ts|*scripts/daemon.ts|--conditions=*) continue ;;   # the rig itself
  esac
  DRIVING="$DRIVING $pid"
done
DRIVING="$(echo "$DRIVING" | tr -s ' ' | sed 's/^ //;s/ $//')"
[ -z "$DRIVING" ] || fail "a probe is ALREADY driving this rig (pid(s):$DRIVING).
Two probes on one instance interleave their sessions and their output, and neither
reading can be attributed afterwards. Wait for it, or kill it deliberately."
echo "  ok  no other probe is driving this rig"


# 1. LEGS ONE AND TWO — the two processes: alive, running out of this worktree,
#    and STARTED AFTER the commit was made. A process that predates the commit
#    cannot be running it, however clean the tree looks now; that is the leg a
#    plain cwd check misses, and it is the one that has caught real staleness.
for name in server daemon; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  [ -f "$pidfile" ] || fail "no $name pidfile — instance is not up"
  pid="$(cat "$pidfile")"
  kill -0 "$pid" 2>/dev/null || fail "$name (pid $pid) is not running — see $PODIUM_DRIVE_BASE/logs/$name.log"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [ "$cwd" = "$(readlink -f "$PODIUM_DRIVE_REPO")" ] \
    || fail "$name (pid $pid) is running from $cwd, not $PODIUM_DRIVE_REPO"
  # WHICH COMMIT THIS PROCESS WAS SPAWNED AT — read back, not inferred.
  #
  # This leg used to ask whether the process STARTED AFTER the commit, via
  # `stat -c %Y /proc/<pid>`. POD-2775's reviewer defeated it and the defeat
  # REPRODUCES on this host: that path returns the INODE's mtime, not the
  # process start time, and 113 of 256 pids skew FORWARD by more than 5 seconds
  # (worst case 7751s) against the real start time from /proc/<pid>/stat.
  #
  # And even with a perfect clock the test was too weak to matter: `started >=
  # committed` is ALSO true for the commit's PARENT, so it could not tell the
  # build under test from the one immediately before it — the only distinction a
  # pin exists to make.
  #
  # drive-up.sh now writes `git rev-parse HEAD` beside the pidfile as it spawns
  # the process, and this compares that RECORDED sha. A recorded fact beats a
  # derived one — the same shape that makes leg 3 (fetching podium-build.json
  # back out of the server) the strongest leg here.
  shafile="$PODIUM_DRIVE_BASE/$name.sha"
  [ -f "$shafile" ] \
    || fail "no $name.sha — this instance was started by a drive-up.sh that did not record its commit, so the pin cannot be checked at all. Re-run drive-up.sh."
  spawned="$(cat "$shafile")"
  [ "$spawned" = "$WANT_SHA" ] \
    || fail "$name (pid $pid) was SPAWNED AT $spawned, you named $WANT_SHA ($WANT) — restart it with drive-up.sh"
  echo "  ok  $name pid=$pid cwd=$cwd spawned at $(printf '%.7s' "$spawned")"
done

# 1b. EXACTLY ONE DAEMON ON THIS STATE ROOT.
#
# Asked for by POD-1761 and worth its own leg: the agent drivers live in the
# daemon, so a SECOND daemon adopting the same state root serves some sessions
# from code the pidfile never named. Every number it touches is then a
# measurement of a process this script never checked — a false negative that
# looks exactly like a broken driver. The pidfile check above cannot see it,
# because the stray daemon has a pid of its own.
#
# Matched on the INSTANCE ID rather than on `scripts/daemon.ts` alone: other
# instances on this box legitimately run their own daemons, and counting those
# would refuse a healthy rig.
#
# PODIUM_INSTANCE, NOT PODIUM_STATE_DIR, and the change is load-bearing. The rig
# no longer exports a state dir (see drive-env.sh, "THE OVERRIDES ARE GONE"), so
# that variable is simply absent from the daemon's environ — and the old test
# compared absent-against-a-path, matched nothing, and would have failed EVERY
# daemon as "found 0". The instance id is the product's own partition key and is
# exported by applyInstanceRuntimeEnv into the process that owns the state root,
# so it is present whether or not anybody overrode a path.
# `pgrep -x bun`, NOT `pgrep -f 'scripts/daemon.ts'`. The environ filter below
# already made this safe, but the candidate list should not depend on a substring
# in the first place: every agent on this box carries the whole Podium prompt in
# its command line, so a -f match on any project string enumerates other
# sessions' processes. -x matches the EXECUTABLE, and the environ filter then
# says which of those bun processes is this instance's.
DAEMON_PIDS="$(pgrep -x bun 2>/dev/null || true)"
MINE=""
for pid in $DAEMON_PIDS; do
  [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$(readlink -f "$PODIUM_DRIVE_REPO")" ] || continue
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmdline" in
    *scripts/daemon.ts*) ;;
    *) continue ;;
  esac
  env_inst="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^PODIUM_INSTANCE=//p' | tail -1)"
  [ -n "$env_inst" ] && [ "$env_inst" = "$PODIUM_INSTANCE" ] && MINE="$MINE $pid"
done
MINE="$(echo "$MINE" | tr -s ' ' | sed 's/^ //;s/ $//')"
COUNT="$(printf '%s' "$MINE" | wc -w)"
[ "$COUNT" -eq 1 ] \
  || fail "expected EXACTLY ONE daemon on instance '$PODIUM_INSTANCE', found $COUNT (pids: ${MINE:-none}).
Two daemons on one state root serve sessions from code this script never checked,
and every number they touch is a false negative wearing the right clothes."
[ "$MINE" = "$(cat "$PODIUM_DRIVE_BASE/daemon.pid")" ] \
  || fail "the only daemon on instance '$PODIUM_INSTANCE' is pid $MINE, but daemon.pid names $(cat "$PODIUM_DRIVE_BASE/daemon.pid") — the rig is not talking to the process it thinks it is"
echo "  ok  exactly one daemon (pid $MINE) on instance '$PODIUM_INSTANCE' (state root $P2777_STATE_ROOT)"

# 2. the worktree those processes read is the named commit, and is clean
HAVE_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)"
[ "$HAVE_SHA" = "$WANT_SHA" ] \
  || fail "worktree is at $HAVE_SHA, you named $WANT_SHA ($WANT)"
DIRTY="$(git -C "$PODIUM_DRIVE_REPO" status --porcelain | grep -v 'docs/evidence/pod-2777/' || true)"
[ -z "$DIRTY" ] || fail "worktree is dirty, so '$WANT' does not name the running bytes:
$DIRTY"
# Say what was actually checked. The exclusion above means "clean" is a claim
# about the PRODUCT tree only; the rig's own scripts are edited between runs by
# design and are not part of the bytes under test. Printing a bare "clean" over
# a filtered check is the kind of unearned word this drive exists to catch.
RIGDIRT="$(git -C "$PODIUM_DRIVE_REPO" status --porcelain -- docs/evidence/pod-2777/ | wc -l)"
echo "  ok  worktree at $HAVE_SHA; product tree clean (apps/ packages/ scripts/ …)$(
  [ "$RIGDIRT" -gt 0 ] && printf ', %s uncommitted file(s) in the rig'"'"'s own docs/evidence/pod-2777/ (excluded by design)' "$RIGDIRT"
)"

# 3. the instance answers, and it is OURS and not the operator's
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null \
  || fail "server does not answer /health on :$PODIUM_PORT"
[ "$PODIUM_PORT" != "19797" ] || fail "refusing to drive the operator's instance"
echo "  ok  server answers on :$PODIUM_PORT (not the operator's 19797)"

# 4. LEG THREE — THE WEB BUNDLE, read back out of the SERVER.
#
# `podium-build.json` is written LAST by the build (POD-1986), so a reader that
# sees it sees a finished dist, and its `sourceSha` is the checkout the bundle
# was built from. Fetching it over HTTP rather than reading the file pins the
# bytes the browser would receive: a server pointed at a different PODIUM_WEB_DIR
# than this worktree's would pass a disk check and fail this one, which is the
# whole difference between "a correct dist exists" and "the correct dist is what
# is being served".
STAMP_JSON="$(curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/podium-build.json" 2>/dev/null || true)"
[ -n "$STAMP_JSON" ] \
  || fail "the server serves no /podium-build.json — the web bundle is absent or unbuilt, so its commit cannot be pinned. Run drive-up.sh."
WEB_SHA="$(printf '%s' "$STAMP_JSON" | sed -n 's/.*"sourceSha": *"\([^"]*\)".*/\1/p')"
[ -n "$WEB_SHA" ] \
  || fail "/podium-build.json carries no sourceSha, so the served bundle cannot name its commit: $STAMP_JSON"
[ "$WEB_SHA" = "$WANT_SHORT" ] \
  || fail "the SERVED web bundle was built from $WEB_SHA, you named $WANT_SHORT ($WANT) — rebuild with drive-up.sh"
echo "  ok  web bundle served from :$PODIUM_PORT was built at $WEB_SHA"

# 5. THE ARM, read out of the RUNNING processes.
#
# Both flags are read ONCE at composition — the contract flag at daemon
# bootstrap, the preview flag at server composition — so a value exported after
# a process started is a value that process has never seen. Reading
# /proc/<pid>/environ is what distinguishes the arm this shell intended from the
# arm those two processes are actually in, and that distinction is the whole
# reason the terminal-driver control arm is trustworthy.
arm_of() { # pid, var  -> prints the value, or the empty string
  tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p" | tail -1
}
SERVER_PID="$(cat "$PODIUM_DRIVE_BASE/server.pid")"
DAEMON_PID="$(cat "$PODIUM_DRIVE_BASE/daemon.pid")"
RUNNING_CONTRACT="$(arm_of "$DAEMON_PID" PODIUM_RUNTIME_CONTRACT)"
RUNNING_STREAMING="$(arm_of "$SERVER_PID" PODIUM_CHAT_STREAMING)"
RUNNING_DRIVER="$(arm_of "$DAEMON_PID" PODIUM_RUNTIME_DRIVER)"
[ "$RUNNING_CONTRACT" = "$PODIUM_RUNTIME_CONTRACT" ] \
  || fail "the daemon is running PODIUM_RUNTIME_CONTRACT='$RUNNING_CONTRACT', you asked for '$PODIUM_RUNTIME_CONTRACT' — restart it with drive-up.sh"
[ "$RUNNING_STREAMING" = "$PODIUM_CHAT_STREAMING" ] \
  || fail "the server is running PODIUM_CHAT_STREAMING='$RUNNING_STREAMING', you asked for '$PODIUM_CHAT_STREAMING' — restart it with drive-up.sh"
[ "$RUNNING_DRIVER" = "${PODIUM_RUNTIME_DRIVER:-}" ] \
  || fail "the daemon is running PODIUM_RUNTIME_DRIVER='$RUNNING_DRIVER', you asked for '${PODIUM_RUNTIME_DRIVER:-}' — restart it with drive-up.sh"
echo "  ok  arm live in the processes: daemon CONTRACT=$RUNNING_CONTRACT DRIVER='${RUNNING_DRIVER:-(policy)}', server STREAMING=$RUNNING_STREAMING"

# The machine-readable line drive.ts reads back, so a report can carry the pin
# it actually ran under rather than one a human retyped.
echo "PINJSON {\"want\":\"$WANT_SHA\",\"short\":\"$WANT_SHORT\",\"spawnedSha\":\"$spawned\",\"serverPid\":$SERVER_PID,\"daemonPid\":$DAEMON_PID,\"webSourceSha\":\"$WEB_SHA\",\"contract\":\"$RUNNING_CONTRACT\",\"streaming\":\"$RUNNING_STREAMING\",\"driver\":\"${RUNNING_DRIVER:-}\"}"
echo "VERIFIED: $PODIUM_INSTANCE (server + daemon + web bundle) is running $WANT_SHA in arm CONTRACT=$RUNNING_CONTRACT STREAMING=$RUNNING_STREAMING DRIVER='${RUNNING_DRIVER:-(policy)}'"
