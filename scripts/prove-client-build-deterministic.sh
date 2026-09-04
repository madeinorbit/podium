#!/usr/bin/env bash
# PROVE THE CLIENT DISTS ARE A PURE FUNCTION OF THEIR INPUTS.
#
# Two fresh worktrees of the same commit must produce byte-identical
# apps/web/dist and apps/mobile/dist — stamp, manifest and .br/.gz siblings
# included. This is the precondition for caching them: nothing can be reused
# across runs while the output differs per run (spec
# docs/internal/superpowers/specs/2026-08-28-cached-release-build-design.md §4.3).
#
# Usage: bash scripts/prove-client-build-deterministic.sh
#
# No file is excluded from the comparison. If a future toolchain embeds
# something per-run, fix it at its source rather than adding an exclusion here —
# an excluded file is a file the cache cannot be trusted about.
set -euo pipefail
sha="$(git rev-parse HEAD)"
tmp="$(mktemp -d)"
trap 'git worktree remove --force "$tmp/a" 2>/dev/null; git worktree remove --force "$tmp/b" 2>/dev/null; rm -rf "$tmp"' EXIT
for w in a b; do
  git worktree add --detach --force "$tmp/$w" "$sha"
  (
    cd "$tmp/$w"
    bun install --frozen-lockfile
    PODIUM_APP_VERSION=0.0.0-determinism bun run --filter @podium/web build
    PODIUM_APP_VERSION=0.0.0-determinism bun run --filter @podium/mobile build
  )
done
diff -r "$tmp/a/apps/web/dist" "$tmp/b/apps/web/dist"
diff -r "$tmp/a/apps/mobile/dist" "$tmp/b/apps/mobile/dist"
echo "client builds are byte-identical at $sha"
