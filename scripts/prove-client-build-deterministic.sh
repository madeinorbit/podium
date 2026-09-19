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
#
# EACH LEG GETS ITS OWN TMPDIR, AND THAT IS WHAT MAKES THIS A PROOF (POD-3775).
#
# Metro stores every transformed module in a FileStore under `os.tmpdir()/metro-cache`
# — machine-global, not per-checkout. Two worktrees of one commit transform identical
# files, so with one TMPDIR the second build REPLAYS the first's transformer output for
# every module and the diff below is identical by construction: the same green the
# comment on the turbo cache in ci.yml refuses, arriving through a cache that job does
# not name. It said nothing for as long as it ran. What it hid was real: lightningcss
# returns a CSS module's class map from a Rust HashMap, whose order is re-rolled on
# every call, so the phone's entry chunk was renaming itself on every uncached build
# and only the release A/B (scripts/ab-headless-cross-vs-native.sh), which compares two
# MACHINES, ever saw it.
#
# A separate TMPDIR per leg makes the second build transform from source, which is the
# only version of this check that can go red. It costs one uncached Metro run.
set -euo pipefail
sha="$(git rev-parse HEAD)"
tmp="$(mktemp -d)"
trap 'git worktree remove --force "$tmp/a" 2>/dev/null; git worktree remove --force "$tmp/b" 2>/dev/null; rm -rf "$tmp"' EXIT
for w in a b; do
  git worktree add --detach --force "$tmp/$w" "$sha"
  mkdir -p "$tmp/$w-tmp"
  (
    cd "$tmp/$w"
    export TMPDIR="$tmp/$w-tmp"
    bun install --frozen-lockfile
    PODIUM_APP_VERSION=0.0.0-determinism bun run --filter @podium/web build
    PODIUM_APP_VERSION=0.0.0-determinism bun run --filter @podium/mobile build
  )
done
diff -r "$tmp/a/apps/web/dist" "$tmp/b/apps/web/dist"
diff -r "$tmp/a/apps/mobile/dist" "$tmp/b/apps/mobile/dist"
echo "client builds are byte-identical at $sha"
