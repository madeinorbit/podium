#!/usr/bin/env bash
set -euo pipefail

export P3110_REPO="/home/mgw/src/podium/.worktrees/issue-3110-grok-paired-final-proof"
export P3110_INSTANCE="p3110-grok-paired-a4a209c-r8"
export P3110_BASE="/tmp/pod-3110-grok-paired-a4a209c-r8"
export P3110_RUN_TOKEN="${P3110_RUN_TOKEN:-$(date -u +%Y%m%dT%H%M%S.%NZ)-$$}"
export P3110_RUN_DIR="$P3110_BASE/runs/$P3110_RUN_TOKEN"
export P3110_PIN="a4a209cc6d902db2c65db0e240a0dbb21aa9b014"
export P3110_GROK_BIN="/home/mgw/.grok/downloads/grok-linux-x86_64"
export P3110_GROK_SHA256="c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6"
export P3110_AGENT_HOME="$(env -u PODIUM_STATE_DIR -u PODIUM_AGENT_HOME -u PODIUM_HOME -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR -u XDG_STATE_HOME PODIUM_INSTANCE="$P3110_INSTANCE" PODIUM_NO_RELAY=1 /home/mgw/.bun/bin/bun --conditions=@podium/source -e 'import { instanceStateDir } from "@podium/runtime/instance"; console.log(`${instanceStateDir()}/agent-home`)')"
export P3110_STATE_DIR="${P3110_AGENT_HOME%/agent-home}"
export P3110_ABDUCO_SOCKET_DIR="$(cd "$P3110_REPO" && env -u PODIUM_STATE_DIR -u PODIUM_AGENT_HOME -u PODIUM_HOME -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR PODIUM_INSTANCE="$P3110_INSTANCE" P3110_STATE_DIR="$P3110_STATE_DIR" /home/mgw/.bun/bin/bun -e 'import { instanceSocketRuntimeDir } from "./packages/runtime/src/instance.ts?pin=a4a209c-r8"; console.log(instanceSocketRuntimeDir(process.env.PODIUM_INSTANCE, process.env.P3110_STATE_DIR))')"
export PATH="/home/mgw/.bun/bin:/home/mgw/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

export PODIUM_INSTANCE="$P3110_INSTANCE"
export PODIUM_PORT="$(env -u PODIUM_STATE_DIR -u PODIUM_AGENT_HOME -u PODIUM_HOME -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR PODIUM_INSTANCE="$P3110_INSTANCE" PODIUM_NO_RELAY=1 /home/mgw/.bun/bin/bun --conditions=@podium/source -e 'import { defaultInstancePorts } from "@podium/runtime/instance"; console.log(defaultInstancePorts(process.env.PODIUM_INSTANCE).server)')"
export PODIUM_PASSWORD="p3110-grok-paired-a4a209c-r8-proof"
export PODIUM_DRIVE_BASE="$P3110_BASE"
export PODIUM_EVIDENCE_DIR="$P3110_REPO/docs/evidence/pod-3110/runs/$P3110_RUN_TOKEN"
export PODIUM_PROBE_REPO="$P3110_BASE/repo"
export PODIUM_HOST="127.0.0.1"
unset PODIUM_SESSION_TOKEN PODIUM_SESSION_RELAY PODIUM_AGENT_RELAY PODIUM_RUNTIME_DRIVER
unset PODIUM_STATE_DIR PODIUM_AGENT_HOME PODIUM_HOME ABDUCO_SOCKET ABDUCO_SOCKET_DIR
