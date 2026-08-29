#!/usr/bin/env bash
# Ensure this checkout resolves every dependency through its own frozen,
# topology-following Bun link graph.
#
# Historical versions of this helper assembled node_modules by symlinking
# entries from another checkout and then repointing @podium locally. That graph
# could pass a build while mixing package payloads and linker topology from two
# branches. The repository contract now has one supported boundary:
# `bun run setup:worktree`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

cd "$REPO"

if [ -L node_modules ]; then
  echo "unsafe node_modules symlink in $REPO; stop checkout processes and run bun run deps:repair" >&2
  exit 1
fi

if [ -d node_modules ]; then
  target="$(readlink -f node_modules/@podium/client-core 2>/dev/null || true)"
  expected="$(readlink -f packages/client-core)"
  if [ -d node_modules/.bun ] && [ "$target" = "$expected" ]; then
    echo "checkout-local node_modules already matches $REPO"
    exit 0
  fi
  echo "damaged or mixed-linker node_modules in $REPO; stop checkout processes and run bun run deps:repair" >&2
  exit 1
fi

exec bun run setup:worktree
