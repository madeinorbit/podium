#!/usr/bin/env bash
# Prove the running p2792 instance IS the commit you name — SERVER, DAEMON AND
# WEB BUNDLE, all three — IN THE ARM you think it is. Exits non-zero on any
# mismatch, and prints nothing a later script could mistake for a pass.
#
#   bash docs/evidence/pod-2792/drive-verify.sh <commit-ish>
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
  started="$(stat -c %Y "/proc/$pid" 2>/dev/null || echo 0)"
  committed="$(git -C "$PODIUM_DRIVE_REPO" show -s --format=%ct "$WANT_SHA")"
  [ "$started" -ge "$committed" ] \
    || fail "$name (pid $pid) started before $WANT_SHA was committed — it cannot be running it"
  echo "  ok  $name pid=$pid cwd=$cwd started after the commit"
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
# Matched on the state root rather than on `scripts/daemon.ts` alone: other
# instances on this box legitimately run their own daemons, and counting those
# would refuse a healthy rig.
DAEMON_PIDS="$(pgrep -f 'scripts/daemon.ts' 2>/dev/null || true)"
MINE=""
for pid in $DAEMON_PIDS; do
  env_root="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^PODIUM_STATE_DIR=//p' | tail -1)"
  [ "$env_root" = "$PODIUM_STATE_DIR" ] && MINE="$MINE $pid"
done
MINE="$(echo "$MINE" | tr -s ' ' | sed 's/^ //;s/ $//')"
COUNT="$(printf '%s' "$MINE" | wc -w)"
[ "$COUNT" -eq 1 ] \
  || fail "expected EXACTLY ONE daemon on state root $PODIUM_STATE_DIR, found $COUNT (pids: ${MINE:-none}).
Two daemons on one state root serve sessions from code this script never checked,
and every number they touch is a false negative wearing the right clothes."
[ "$MINE" = "$(cat "$PODIUM_DRIVE_BASE/daemon.pid")" ] \
  || fail "the only daemon on $PODIUM_STATE_DIR is pid $MINE, but daemon.pid names $(cat "$PODIUM_DRIVE_BASE/daemon.pid") — the rig is not talking to the process it thinks it is"
echo "  ok  exactly one daemon (pid $MINE) on state root $PODIUM_STATE_DIR"

# 2. the worktree those processes read is the named commit, and is clean
HAVE_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)"
[ "$HAVE_SHA" = "$WANT_SHA" ] \
  || fail "worktree is at $HAVE_SHA, you named $WANT_SHA ($WANT)"
DIRTY="$(git -C "$PODIUM_DRIVE_REPO" status --porcelain | grep -v 'docs/evidence/pod-2792/' || true)"
[ -z "$DIRTY" ] || fail "worktree is dirty, so '$WANT' does not name the running bytes:
$DIRTY"
echo "  ok  worktree at $HAVE_SHA, clean"

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
echo "PINJSON {\"want\":\"$WANT_SHA\",\"short\":\"$WANT_SHORT\",\"serverPid\":$SERVER_PID,\"daemonPid\":$DAEMON_PID,\"webSourceSha\":\"$WEB_SHA\",\"contract\":\"$RUNNING_CONTRACT\",\"streaming\":\"$RUNNING_STREAMING\",\"driver\":\"${RUNNING_DRIVER:-}\"}"
echo "VERIFIED: p2792 (server + daemon + web bundle) is running $WANT_SHA in arm CONTRACT=$RUNNING_CONTRACT STREAMING=$RUNNING_STREAMING DRIVER='${RUNNING_DRIVER:-(policy)}'"
