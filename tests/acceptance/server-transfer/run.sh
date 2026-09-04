#!/usr/bin/env bash
set -euo pipefail

if [[ "${PODIUM_DOCKER_TRANSFER:-}" != "1" ]]; then
  echo "SKIP server-transfer Docker acceptance: set PODIUM_DOCKER_TRANSFER=1 to opt in"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP server-transfer Docker acceptance: docker CLI is unavailable"
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "SKIP server-transfer Docker acceptance: Docker daemon is unavailable"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE="$ROOT/tests/acceptance/server-transfer/compose.yml"
PROJECT_BASE="podium-transfer-${PPID}-$$"

cleanup_project=""
cleanup_scenario="g1"
cleanup() {
  if [[ -n "$cleanup_project" ]]; then
    PODIUM_TRANSFER_SCENARIO="$cleanup_scenario" docker compose -f "$COMPOSE" -p "$cleanup_project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "== building disposable server-move fixture =="
PODIUM_TRANSFER_SCENARIO=g1 docker compose -f "$COMPOSE" -p "${PROJECT_BASE}-build" build

for scenario in g1 g2 g3 g4a g4b g5 g6 g7 g8 g9 g10; do
  crash_point=""
  fail_point=""
  if [[ "$scenario" == "g5" ]]; then crash_point="after-promote"; fi
  if [[ "$scenario" == "g10" ]]; then fail_point="after-seal"; fi

  cleanup_project="${PROJECT_BASE}-${scenario}"
  cleanup_scenario="$scenario"
  echo "== server-move scenario: $scenario =="
  PODIUM_TRANSFER_SCENARIO="$scenario" PODIUM_SERVER_MOVE_CRASH_POINT="$crash_point" PODIUM_SERVER_MOVE_FAIL_POINT="$fail_point" docker compose -f "$COMPOSE" -p "$cleanup_project" up --abort-on-container-exit --exit-code-from scenario
  PODIUM_TRANSFER_SCENARIO="$scenario" docker compose -f "$COMPOSE" -p "$cleanup_project" logs --no-color source target control-proxy scenario
  PODIUM_TRANSFER_SCENARIO="$scenario" docker compose -f "$COMPOSE" -p "$cleanup_project" down --volumes --remove-orphans
  cleanup_project=""
done

echo "PASS server-move Docker G1-G10 acceptance"
