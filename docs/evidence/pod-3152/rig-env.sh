#!/usr/bin/env bash
set -euo pipefail

export P3152_REPO="/home/mgw/src/podium/.worktrees/issue-3152-grok-reply-repair-proof"
export P3152_INSTANCE="p3152-grok-reply-0d180cc-r10"
export P3152_EXPECTED_PORTS="37325 37326 37327"
export P3152_BASE="/tmp/pod-3152-grok-reply-0d180cc-r10"
export P3152_RUN_TOKEN="${P3152_RUN_TOKEN:-$(date -u +%Y%m%dT%H%M%S.%NZ)-$$}"
export P3152_RUN_DIR="$P3152_BASE/runs/$P3152_RUN_TOKEN"
export P3152_PIN="0d180cc0455832ffe93edf2ac450a47f5f7c8137"
export P3152_GROK_BIN="/home/mgw/.grok/downloads/grok-linux-x86_64"
export P3152_GROK_SHA256="c192282e62abd24a9be64750363ff827d806ba613918399a8c69c815b1da08f6"
export P3152_AGENT_HOME="$(env -u PODIUM_STATE_DIR -u PODIUM_AGENT_HOME -u PODIUM_HOME -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR -u XDG_STATE_HOME PODIUM_INSTANCE="$P3152_INSTANCE" PODIUM_NO_RELAY=1 /home/mgw/.bun/bin/bun --conditions=@podium/source -e 'import { instanceStateDir } from "@podium/runtime/instance"; console.log(`${instanceStateDir()}/agent-home`)')"
export P3152_STATE_DIR="${P3152_AGENT_HOME%/agent-home}"
export P3152_ABDUCO_SOCKET_DIR="$(cd "$P3152_REPO" && env -u PODIUM_STATE_DIR -u PODIUM_AGENT_HOME -u PODIUM_HOME -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR PODIUM_INSTANCE="$P3152_INSTANCE" P3152_STATE_DIR="$P3152_STATE_DIR" /home/mgw/.bun/bin/bun -e 'import { instanceSocketRuntimeDir } from "./packages/runtime/src/instance.ts?pin=0d180cc-r10"; console.log(instanceSocketRuntimeDir(process.env.PODIUM_INSTANCE, process.env.P3152_STATE_DIR))')"
export PATH="/home/mgw/.bun/bin:/home/mgw/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

export PODIUM_INSTANCE="$P3152_INSTANCE"
export PODIUM_PORT="$(env -u PODIUM_STATE_DIR -u PODIUM_AGENT_HOME -u PODIUM_HOME -u PODIUM_RUNTIME_DRIVER -u ABDUCO_SOCKET_DIR PODIUM_INSTANCE="$P3152_INSTANCE" PODIUM_NO_RELAY=1 /home/mgw/.bun/bin/bun --conditions=@podium/source -e 'import { defaultInstancePorts } from "@podium/runtime/instance"; console.log(defaultInstancePorts(process.env.PODIUM_INSTANCE).server)')"
export PODIUM_PASSWORD="p3152-grok-reply-0d180cc-r10-proof"
export PODIUM_DRIVE_BASE="$P3152_BASE"
export PODIUM_EVIDENCE_DIR="$P3152_REPO/docs/evidence/pod-3152/runs/$P3152_RUN_TOKEN"
export PODIUM_PROBE_REPO="$P3152_BASE/repo"
export PODIUM_HOST="127.0.0.1"
unset PODIUM_SESSION_TOKEN PODIUM_SESSION_RELAY PODIUM_AGENT_RELAY PODIUM_RUNTIME_DRIVER
unset PODIUM_STATE_DIR PODIUM_AGENT_HOME PODIUM_HOME ABDUCO_SOCKET ABDUCO_SOCKET_DIR
