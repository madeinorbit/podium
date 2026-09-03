#!/usr/bin/env bash
set -euo pipefail

export PODIUM_INSTANCE=p2987q-8271743
export PODIUM_DRIVE_BASE=/tmp/pod-2987-20260827T1743
export PODIUM_PORT=32987
export PODIUM_HOOK_PORT=46987
export PODIUM_AGENT_RELAY_PORT=46988
export PODIUM_HOST=127.0.0.1
export PODIUM_PASSWORD=p2987-quota
export PODIUM_DRIVE_REPO=/home/mgw/src/podium/.worktrees/issue-2987-claude-quota-parity

. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/rig-path-guard.sh"

unset PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY PODIUM_AGENT_RELAY
unset PODIUM_HOME PODIUM_WEB_DIR CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH
export PODIUM_NO_RELAY=1
export PATH="/home/mgw/.bun/bin:/home/mgw/.local/bin:$PATH"
