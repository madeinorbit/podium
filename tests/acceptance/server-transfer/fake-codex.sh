#!/bin/sh
set -eu

if [ "${1:-}" = "--version" ]; then
  echo "codex-cli 0.144.5"
  exit 0
fi

exec /workspace/node_modules/.bin/tsx /workspace/tests/keyecho/src/cli.tsx --mode raw --lock
