#!/usr/bin/env bash
set -euo pipefail

export P3110_REPO="/home/mgw/src/podium/.worktrees/issue-3110-grok-paired-final-proof"
export P3110_INSTANCE="p3110-grok-paired-final-tip-2af0"
export P3110_BASE="/tmp/pod-3110-grok-paired-final-tip-2af0"
export P3110_PIN="2af0b8f7448d6b1ce4ad7a12af2c8226c54e18cd"
export P3110_GROK_BIN="/home/mgw/.grok/downloads/grok-linux-x86_64"
export P3110_GROK_SHA256="c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6"
export PATH="/home/mgw/.bun/bin:/home/mgw/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

export PODIUM_INSTANCE="$P3110_INSTANCE"
export PODIUM_PORT="$(env -u PODIUM_STATE_DIR -u PODIUM_AGENT_HOME -u PODIUM_HOME -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR PODIUM_INSTANCE="$P3110_INSTANCE" PODIUM_NO_RELAY=1 /home/mgw/.bun/bin/bun --conditions=@podium/source -e 'import { defaultInstancePorts } from "@podium/runtime/instance"; console.log(defaultInstancePorts(process.env.PODIUM_INSTANCE).server)')"
export PODIUM_PASSWORD="p3110-grok-paired-final-tip-2af0-proof"
export PODIUM_DRIVE_BASE="$P3110_BASE"
export PODIUM_PROBE_REPO="$P3110_BASE/repo"
export PODIUM_HOST="127.0.0.1"
unset PODIUM_SESSION_TOKEN PODIUM_SESSION_RELAY PODIUM_AGENT_RELAY PODIUM_RUNTIME_DRIVER
unset PODIUM_STATE_DIR PODIUM_AGENT_HOME PODIUM_HOME ABDUCO_SOCKET ABDUCO_SOCKET_DIR
