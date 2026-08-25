#!/usr/bin/env bash
# Prove the running p2773 instance IS the commit you name, IN THE ARM you think
# it is. Exits non-zero on any mismatch, and prints nothing a later script could
# mistake for a pass.
#
#   bash docs/evidence/pod-2773/drive-verify.sh <commit-ish>
#
# WHY THIS EXISTS. Stale-rig conclusions have been drawn on this epic three
# times, always the same shape: something was measured, the number was believed,
# and nobody checked that the processes producing it were running the code under
# test. Static checks on a worktree cannot answer that — the daemon is a
# long-lived bun process that read its source minutes or hours ago, and the
# DRIVERS ARE LOADED AT ITS PROCESS START, so repinning a checkout underneath a
# running daemon changes precisely nothing.
#
# There is deliberately NO "is the fix loaded" probe against /proc. A JS module
# is read() and closed, never left mmapped, so /proc/<pid>/{maps,map_files,fd}
# cannot see it and a check written that way passes vacuously whether the code
# is loaded or not — POD-2753 shipped one and had to withdraw it.
#
# What CAN be read out of a running process is its environment, and on this
# drive the environment IS the arm. So check 4 reads the flags back out of the
# daemon rather than trusting the shell that meant to set them.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

WANT="${1:?usage: drive-verify.sh <commit-ish>}"
WANT_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse "$WANT")"
fail() { echo "VERIFY FAILED: $*" >&2; exit 1; }

# 1. processes alive, running out of this worktree, and STARTED AFTER the commit
for name in server daemon; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  [ -f "$pidfile" ] || fail "no $name pidfile — instance is not up"
  pid="$(cat "$pidfile")"
  kill -0 "$pid" 2>/dev/null || fail "$name (pid $pid) is not running — see $PODIUM_DRIVE_BASE/logs/$name.log"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [ "$cwd" = "$(readlink -f "$PODIUM_DRIVE_REPO")" ] \
    || fail "$name (pid $pid) is running from $cwd, not $PODIUM_DRIVE_REPO"
  # A process that predates the commit cannot be running it, however clean the
  # tree looks now. This is the leg a plain cwd check misses.
  started="$(stat -c %Y "/proc/$pid" 2>/dev/null || echo 0)"
  committed="$(git -C "$PODIUM_DRIVE_REPO" show -s --format=%ct "$WANT_SHA")"
  [ "$started" -ge "$committed" ] \
    || fail "$name (pid $pid) started before $WANT_SHA was committed — it cannot be running it"
  echo "  ok  $name pid=$pid cwd=$cwd started after the commit"
done

# 2. the worktree those processes read is the named commit, and is clean
HAVE_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)"
[ "$HAVE_SHA" = "$WANT_SHA" ] \
  || fail "worktree is at $HAVE_SHA, you named $WANT_SHA ($WANT)"
DIRTY="$(git -C "$PODIUM_DRIVE_REPO" status --porcelain | grep -v 'docs/evidence/pod-2773/' || true)"
[ -z "$DIRTY" ] || fail "worktree is dirty, so '$WANT' does not name the running bytes:
$DIRTY"
echo "  ok  worktree at $HAVE_SHA, clean"

# 3. the instance answers, and it is OURS and not the operator's
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null \
  || fail "server does not answer /health on :$PODIUM_PORT"
[ "$PODIUM_PORT" != "19797" ] || fail "refusing to drive the operator's instance"
echo "  ok  server answers on :$PODIUM_PORT (not the operator's 19797)"

# 4. THE ARM, read out of the RUNNING processes.
#
# Both flags are read ONCE at composition — the contract flag at daemon
# bootstrap, the preview flag at server composition — so a value exported after
# a process started is a value that process has never seen. Reading
# /proc/<pid>/environ is what distinguishes the arm this shell intended from the
# arm those two processes are actually in, and that distinction is the whole
# reason the control arm is trustworthy.
arm_of() { # pid, var  -> prints the value, or the empty string
  tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p" | tail -1
}
SERVER_PID="$(cat "$PODIUM_DRIVE_BASE/server.pid")"
DAEMON_PID="$(cat "$PODIUM_DRIVE_BASE/daemon.pid")"
RUNNING_CONTRACT="$(arm_of "$DAEMON_PID" PODIUM_RUNTIME_CONTRACT)"
RUNNING_STREAMING="$(arm_of "$SERVER_PID" PODIUM_CHAT_STREAMING)"
[ "$RUNNING_CONTRACT" = "$PODIUM_RUNTIME_CONTRACT" ] \
  || fail "the daemon is running PODIUM_RUNTIME_CONTRACT='$RUNNING_CONTRACT', you asked for '$PODIUM_RUNTIME_CONTRACT' — restart it with drive-up.sh"
[ "$RUNNING_STREAMING" = "$PODIUM_CHAT_STREAMING" ] \
  || fail "the server is running PODIUM_CHAT_STREAMING='$RUNNING_STREAMING', you asked for '$PODIUM_CHAT_STREAMING' — restart it with drive-up.sh"
echo "  ok  arm live in the processes: daemon CONTRACT=$RUNNING_CONTRACT, server STREAMING=$RUNNING_STREAMING"

echo "VERIFIED: p2773 is running $WANT_SHA in arm CONTRACT=$RUNNING_CONTRACT STREAMING=$RUNNING_STREAMING"
