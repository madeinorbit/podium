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
  # WHICH COMMIT IT WAS SPAWNED FROM — read, not inferred.
  #
  # This leg used to compare `stat -c %Y /proc/<pid>` against the commit's
  # timestamp, and it was defeated twice over. `%Y` on /proc/<pid> is the INODE
  # MTIME rather than the process start time: measured on this host, 100 of 240
  # live pids skew by more than 5s and the worst by 7751s, FORWARD — so a
  # process older than the commit read as newer than it, which is the direction
  # that makes a stale rig pass. And `started >= committed` is satisfied by the
  # PARENT commit too, so it could not separate the build under test from the
  # one immediately before it — a check that passes on exactly the thing it is
  # meant to rule out.
  #
  # `drive-up.sh` now writes the sha (and the tree's cleanliness) at spawn.
  # Nothing here is reconstructed from a clock.
  shafile="$PODIUM_DRIVE_BASE/$name.sha"
  [ -f "$shafile" ] || fail "no $shafile — this instance was not started by drive-up.sh, so what it is running cannot be established"
  spawn_sha="$(cut -d' ' -f1 "$shafile")"
  spawn_tree="$(cut -d' ' -f2 "$shafile")"
  [ "$spawn_sha" = "$WANT_SHA" ] \
    || fail "$name (pid $pid) was spawned from $spawn_sha, you named $WANT_SHA — restart the pair"
  [ "$spawn_tree" = "clean" ] \
    || fail "$name (pid $pid) was spawned from a DIRTY tree at $spawn_sha, so the sha does not name the bytes it read"
  echo "  ok  $name pid=$pid cwd=$cwd spawned from $spawn_sha (clean)"
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

# 4. …and the thing answering is OUR server, not another rig's on the same port.
#
# MEASURED, NOT ASSUMED. POD-2777's acceptance rig picked 19847/46847/46848 —
# the same three this rig started on — and on a shared host the loser of that
# race fails to bind while /health keeps answering 200 from the WINNER. Every
# check above passes in that state: the port answers, the worktree is clean, the
# sha matches. The drive then logs in to somebody else's daemon and measures
# their sessions. /health carries no instance id, so the pid that HOLDS the
# listener is compared against the pid this rig started.
PIDFILE="$PODIUM_DRIVE_BASE/server.pid"
[ -f "$PIDFILE" ] || fail "no $PIDFILE — run drive-up.sh first"
OURS="$(cat "$PIDFILE")"
HOLDER="$(ss -lntp 2>/dev/null | awk -v p=":$PODIUM_PORT " '$0 ~ p' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
[ -n "$HOLDER" ] || fail "nothing holds :$PODIUM_PORT, yet /health answered — refusing to guess"
[ "$HOLDER" = "$OURS" ] \
  || fail "port :$PODIUM_PORT is held by pid $HOLDER, not our server ($OURS).
Another rig is on this port; move PODIUM_PORT rather than measuring theirs."
echo "  ok  :$PODIUM_PORT is held by OUR server (pid $OURS)"

echo "VERIFIED: p2775 is running $WANT_SHA"
