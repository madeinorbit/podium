#!/usr/bin/env bash
# Prove the running p2775 instance IS the commit you name. Exits non-zero on any
# mismatch, and prints nothing a later script could mistake for a pass.
#
#   bash docs/evidence/pod-2775/drive-verify.sh <commit-ish>
#
# WHY THIS EXISTS. A drive against a stale rig has produced false results on this
# epic repeatedly, always the same shape: something was measured, the number was
# believed, and nobody checked that the processes producing it were running the
# code under test. Static checks on a worktree cannot answer that — the daemon is
# a long-lived bun process that read its source minutes or hours ago.
#
# THE DAEMON IS THE ONE THAT MATTERS HERE. Every line under test lives in
# apps/daemon/src/runtime/ — `server-reap.ts` and `codex-app-server.ts` — so a
# rig with a fresh server and a stale daemon would reproduce the bug and read as
# "the fix does not work".
#
# There is deliberately NO "is the fix loaded" probe. A JS module is read() and
# closed, never left mmapped, so /proc/<pid>/{maps,map_files,fd} cannot see it —
# a check written that way passes vacuously whether the code is loaded or not
# (POD-2753 shipped one and had to withdraw it). What replaces it: checks 1-3
# establish that these processes were started from this worktree at this clean
# commit, and the DRIVE itself is the behavioural check.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=drive-env.sh
. "$HERE/drive-env.sh"

WANT="${1:?usage: drive-verify.sh <commit-ish>}"
WANT_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse "$WANT")"
fail() { echo "VERIFY FAILED: $*" >&2; exit 1; }

# 1. processes alive, and running out of this worktree
for name in server daemon; do
  pidfile="$PODIUM_DRIVE_BASE/$name.pid"
  [ -f "$pidfile" ] || fail "no $name pidfile — instance is not up"
  pid="$(cat "$pidfile")"
  kill -0 "$pid" 2>/dev/null || fail "$name (pid $pid) is not running — see $PODIUM_DRIVE_BASE/logs/$name.log"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [ "$cwd" = "$(readlink -f "$PODIUM_DRIVE_REPO")" ] \
    || fail "$name (pid $pid) is running from $cwd, not $PODIUM_DRIVE_REPO"
  # START TIME vs the commit: a daemon that predates the commit cannot be running
  # it, however clean the tree looks now. This is the leg that a plain cwd check
  # misses, and it is exactly the mistake this rig exists to prevent.
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
# The rig's OWN files are excluded whatever their git state — staged, modified or
# untracked. Nothing under this directory is imported by the server or the
# daemon, so editing the drive between runs cannot change the bytes under test,
# and a rig that refused to run while you were writing it would be edited into
# uselessness. Every other path counts.
DIRTY="$(git -C "$PODIUM_DRIVE_REPO" status --porcelain | grep -v ' docs/evidence/pod-2775/' | grep -v '^?? docs/evidence/pod-2775/' || true)"
[ -z "$DIRTY" ] || fail "worktree is dirty, so '$WANT' does not name the running bytes:
$DIRTY"
echo "  ok  worktree at $HAVE_SHA, clean"

# 3. the instance answers, and it is OURS and not the operator's
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null \
  || fail "server does not answer /health on :$PODIUM_PORT"
[ "$PODIUM_PORT" != "19797" ] || fail "refusing to drive the operator's instance"
echo "  ok  server answers on :$PODIUM_PORT (not the operator's 19797)"

echo "VERIFIED: p2775 is running $WANT_SHA"
