#!/usr/bin/env bash
# Prove the running p2753 instance IS the commit you name. Exits non-zero on any
# mismatch, and prints nothing a later script could mistake for a pass.
#
#   bash docs/evidence/pod-2753/drive-verify.sh <commit-ish>
#
# WHY THIS EXISTS. A drive against a dying or stale rig has produced false
# negatives on this epic four times. Every one of them was the same shape:
# something was measured, the number was believed, and nobody had checked that
# the processes producing it were running the code under test. Static checks on a
# worktree cannot answer that — the daemon is a long-lived bun process that read
# its source minutes or hours ago.
#
# So each check below reads the RUNNING PROCESS, not the repository:
#   1. server and daemon pids are alive and their /proc cwd is this worktree
#   2. the worktree is at the named commit and is CLEAN, so "this commit" names
#      the bytes those processes actually read
#   3. the daemon answers as this instance
#   4. the daemon's own module graph does not contain the SDK — checked against
#      the running process's open files, not against the source tree

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
  echo "  ok  $name pid=$pid cwd=$cwd"
done

# 2. the worktree those processes read is the named commit, and is clean
HAVE_SHA="$(git -C "$PODIUM_DRIVE_REPO" rev-parse HEAD)"
[ "$HAVE_SHA" = "$WANT_SHA" ] \
  || fail "worktree is at $HAVE_SHA, you named $WANT_SHA ($WANT)"
DIRTY="$(git -C "$PODIUM_DRIVE_REPO" status --porcelain | grep -v '^?? docs/evidence/pod-2753/' || true)"
[ -z "$DIRTY" ] || fail "worktree is dirty, so '$WANT' does not name the running bytes:
$DIRTY"
echo "  ok  worktree at $HAVE_SHA, clean"

# 3. the instance answers
curl -fsS "http://$PODIUM_HOST:$PODIUM_PORT/health" >/dev/null \
  || fail "server does not answer /health on :$PODIUM_PORT"
echo "  ok  server answers on :$PODIUM_PORT"

# 4. THE PROPERTY UNDER TEST.
#
# THIS CHECK USED TO BE VACUOUS AND IS THE REASON THIS COMMENT IS LONG. It grepped
# /proc/<daemon>/map_files and /proc/<daemon>/fd for "claude-agent-sdk" and printed
# "ok" when it found nothing. An adversarial review pointed out it could not fail;
# I then reproduced it directly. A bun process that has imported the SDK and holds
# a CALLABLE query() shows:
#
#     /proc/<pid>/maps       matching claude-agent-sdk : 0
#     /proc/<pid>/map_files  matching                  : 0
#     /proc/<pid>/fd         matching                  : 0
#     /proc/<pid>/maps       mentioning anthropic      : 0
#
# A JS module is read() and closed; it is never left mmapped. So the old check
# passed on a daemon that HAD the SDK loaded — a negative assertion with no
# control, inside the very script whose job is to refuse unproven measurements.
# There is no external detector for "this process has a JS module loaded", so the
# honest move is to stop pretending there is one.
#
# WHAT REPLACES IT. The property is STATIC — it is about the module graph of the
# code these processes are running — so it is checked where it can actually fail:
# the isolation test walks that graph from every daemon-hosting entry point and
# goes red when the SDK is reachable. Checks 1 and 2 above are what make that
# relevant HERE: the running processes were started from this worktree, and this
# worktree is at the named commit with a clean tree. So "the test passes at this
# commit" is a statement about the bytes those processes actually loaded.
echo "  .. running the SDK isolation walk against this commit (this is the real check)"
if ! ( cd "$PODIUM_DRIVE_REPO" && ./node_modules/.bin/vitest run \
        apps/daemon/src/claude-sdk-isolation.test.ts >/tmp/pod-2753-isolation.log 2>&1 ); then
  echo "  ---- isolation test output ----" >&2
  tail -40 /tmp/pod-2753-isolation.log >&2
  fail "the SDK is reachable from a daemon-hosting entry point at $HAVE_SHA"
fi
echo "  ok  the SDK is unreachable from every daemon-hosting entry point at this commit"

echo "VERIFIED: p2753 is running $WANT_SHA"
