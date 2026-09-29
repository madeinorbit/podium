#!/bin/sh
# Creates a scratch CODEX_HOME: fake provider on localhost, dummy key (FAKE_KEY), every one of the
# 11 hook events Codex 0.155.0 knows logged by hooklog.sh. Usage: setup-home.sh <run-dir> <port>
set -eu
R=$1
PORT=$2
T=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/home/.codex" "$R/work"
cat > "$R/home/.codex/config.toml" <<EOF
model = "fake"
model_provider = "fake"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false

[features]
hooks = true

[model_providers.fake]
name = "fake"
base_url = "http://127.0.0.1:$PORT/v1"
env_key = "FAKE_KEY"
wire_api = "responses"

[projects."$R/work"]
trust_level = "trusted"
EOF
{
  printf '{"hooks":{'
  first=1
  for ev in SessionStart SessionEnd UserPromptSubmit PreToolUse PermissionRequest PostToolUse PreCompact PostCompact SubagentStart SubagentStop Stop; do
    [ $first = 1 ] || printf ','
    first=0
    printf '"%s":[{"hooks":[{"type":"command","command":"sh %s/hooklog.sh %s"}]}]' "$ev" "$T" "$ev"
  done
  printf '}}\n'
} > "$R/home/.codex/hooks.json"
