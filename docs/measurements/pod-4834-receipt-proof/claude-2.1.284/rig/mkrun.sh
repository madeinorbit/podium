#!/bin/bash
# mkrun.sh NAME PORT — scratch config, all 33 hook events, fake server + transcript watcher started.
set -e
RIG=$(cd "$(dirname "$0")" && pwd)
mkdir -p $RIG/../runs/$1; R=$(realpath $RIG/../runs/$1); PORT=$2
mkdir -p $R/cfg $R/work $R/ctl
KEY=fake-key-for-the-local-fake-server-not-a-credential
EVENTS="PreToolUse PostToolUse PostToolUseFailure PostToolBatch Notification UserPromptSubmit UserPromptExpansion SessionStart SessionEnd Stop StopFailure SubagentStart SubagentStop PreCompact PostCompact PreModelSwitch PostModelSwitch PermissionRequest PermissionDenied Setup TeammateIdle TaskCreated TaskCompleted Elicitation ElicitationResult ConfigChange WorktreeCreate WorktreeRemove InstructionsLoaded CwdChanged FileChanged DirectoryAdded MessageDisplay"
python3 - "$R" "$RIG" "$KEY" $EVENTS <<'PY'
import json,sys
R,RIG,KEY,*ev=sys.argv[1:]
hooks={e:[{"matcher":"*","hooks":[{"type":"command","command":f"{RIG}/hook.sh {e}"}]}] for e in ev}
json.dump({"hooks":hooks,"permissions":{"allow":["Bash(sleep:*)","Bash(sleep 8)","Bash(sleep 3)"]},"statusLine":{"type":"command","command":f"{RIG}/statusline.sh"}},open(f"{R}/cfg/settings.json","w"),indent=1)
json.dump({"hasCompletedOnboarding":True,"theme":"dark","customApiKeyResponses":{"approved":[KEY[-20:]],"rejected":[]},"projects":{f"{R}/work":{"hasTrustDialogAccepted":True,"hasCompletedProjectOnboarding":True,"allowedTools":[]}}},open(f"{R}/cfg/.claude.json","w"),indent=1)
PY
cat > $R/env.sh <<E2
export CLAUDE_CONFIG_DIR=$R/cfg ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_API_KEY=$KEY CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 HOOK_LOG=$R/hooks.jsonl STATUS_LOG=$R/statusline.jsonl CTL=$R/ctl DISABLE_AUTOUPDATER=1
E2
fuser -k $PORT/tcp 2>/dev/null || true
FAKE_PORT=$PORT FAKE_LOG=$R/model-requests.jsonl setsid nohup bun $RIG/fake.ts > $R/fake.out 2>&1 < /dev/null &
WATCH_DIR=$R/cfg WATCH_LOG=$R/transcript-watch.jsonl setsid nohup bun $RIG/watch.ts > $R/watch.out 2>&1 < /dev/null &
echo $! > $R/watch.pid
sleep 1; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/v1/x
