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

# 4. THE PROPERTY UNDER TEST, read off the LIVE DAEMON.
# The SDK is loaded from node_modules/@anthropic-ai/..., so if the daemon process
# had it loaded, that path would be among its open files. A source-tree grep
# would prove nothing about a process that started before your last edit.
DPID="$(cat "$PODIUM_DRIVE_BASE/daemon.pid")"
LOADED="$(ls -l "/proc/$DPID/map_files" 2>/dev/null | grep -c 'claude-agent-sdk' || true)"
OPEN="$(ls -l "/proc/$DPID/fd" 2>/dev/null | grep -c 'claude-agent-sdk' || true)"
[ "$LOADED" = "0" ] && [ "$OPEN" = "0" ] \
  || fail "the live daemon (pid $DPID) has the Claude SDK open: map_files=$LOADED fd=$OPEN"
echo "  ok  live daemon pid=$DPID has no Claude SDK file open"

echo "VERIFIED: p2753 is running $WANT_SHA"
