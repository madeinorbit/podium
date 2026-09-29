#!/bin/bash
# One measurement run: fresh scratch CODEX_HOME, fake model server, history watcher, then the
# given command (with R, FAKE_PORT, HOOK_LOG, FRAMES_LOG set). Logs land in <run-dir>/log/.
# Usage: run.sh <run-dir> <port> <command...>
set -u
R=$1; PORT=$2; shift 2
T=$(cd "$(dirname "$0")" && pwd)
rm -rf "$R"; mkdir -p "$R/log"
sh "$T/setup-home.sh" "$R" "$PORT"
export R FAKE_PORT=$PORT HOOK_LOG=$R/log/hooks.jsonl FRAMES_LOG=$R/log/frames.jsonl
FAKE_LOG=$R/log/model-requests.jsonl bun "$T/fake-responses-server.ts" & FAKE=$!
CODEX_HOME=$R/home/.codex WATCH_LOG=$R/log/history.jsonl bun "$T/watch-history.ts" & WATCH=$!
bun "$T/trust-hooks.ts" >/dev/null && : > "$FRAMES_LOG"
sleep 1
"$@"; rc=$?
sleep 1
kill $WATCH 2>/dev/null
fuser -k "$PORT/tcp" >/dev/null 2>&1
wait 2>/dev/null
echo "run rc=$rc"
