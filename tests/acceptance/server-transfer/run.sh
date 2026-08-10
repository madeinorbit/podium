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
cleanup() {
  if [[ -n "$cleanup_project" ]]; then
    docker compose -f "$COMPOSE" -p "$cleanup_project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "== building disposable server-transfer fixture =="
PODIUM_TRANSFER_SCENARIO=success docker compose -f "$COMPOSE" -p "${PROJECT_BASE}-build" build

for scenario in success precommit-abort lost-commit-reply; do
  cleanup_project="${PROJECT_BASE}-${scenario}"
  echo "== server-transfer scenario: $scenario =="
  PODIUM_TRANSFER_SCENARIO="$scenario" docker compose -f "$COMPOSE" -p "$cleanup_project" up \
    --abort-on-container-exit \
    --exit-code-from scenario
  docker compose -f "$COMPOSE" -p "$cleanup_project" logs --no-color source target control-proxy scenario
  docker compose -f "$COMPOSE" -p "$cleanup_project" down --volumes --remove-orphans
  cleanup_project=""
done

echo "PASS server-transfer Docker acceptance"
