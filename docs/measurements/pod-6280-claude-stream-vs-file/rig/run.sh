#!/bin/bash
# run.sh — on the VM: scratch config, fake server, watcher, one drive. Usage: run.sh <rigdir> <port>
set -e
RIG=$1; PORT=$2; R=$RIG/run-$(date +%s); mkdir -p $R/cfg $R/work
export PATH=$HOME/podium-test-6280/.toolchain:$PATH
KEY=fake-key-for-the-local-fake-server-not-a-credential
python3 - "$R" "$KEY" <<'PY'
import json,sys
R,KEY=sys.argv[1:]
json.dump({"permissions":{"allow":["Bash(true)"]}},open(f"{R}/cfg/settings.json","w"))
json.dump({"hasCompletedOnboarding":True,"theme":"dark","customApiKeyResponses":{"approved":[KEY[-20:]],"rejected":[]},"projects":{f"{R}/work":{"hasTrustDialogAccepted":True,"hasCompletedProjectOnboarding":True,"allowedTools":[]}}},open(f"{R}/cfg/.claude.json","w"))
PY
export CLAUDE_CONFIG_DIR=$R/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_API_KEY=$KEY CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 CLAUDE_BIN=$RIG/claude WORK=$R/work OUT=$R/stdout.tsv
FAKE_PORT=$PORT FAKE_LOG=$R/model.jsonl bun $RIG/fake.ts > $R/fake.out 2>&1 & FAKE=$!
WATCH_DIR=$R/cfg WATCH_LOG=$R/watch.jsonl bun $RIG/watch.ts > $R/watch.out 2>&1 & WATCH=$!
sleep 1
timeout 90 bun $RIG/drive.ts || echo "drive rc=$?"
sleep 0.5
kill $FAKE $WATCH 2>/dev/null || true
echo "$R"
