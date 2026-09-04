#!/usr/bin/env bash
# Give this worktree a node_modules that resolves @podium/* to ITS OWN packages.
#
# WHY THIS EXISTS, AND IT IS NOT A CONVENIENCE. A worktree with no node_modules
# resolves a bare package name by WALKING UP THE FILESYSTEM, and the next
# node_modules up is /home/mgw/src/podium/node_modules — whose @podium/* entries
# symlink into the MAIN CHECKOUT's packages. That checkout is routinely on some
# other issue's branch. The first run of this drive hit exactly that: vite
# resolved `@podium/client-core/viewmodels` four levels up, into a checkout
# sitting on issue/2417, and failed on three exports that exist perfectly well
# on the epic branch.
#
# A build that had NOT failed would have been the real damage. It would have
# bundled another branch's client code into a dist this rig then certifies, with
# `podium-build.json` naming OUR commit — a wrong certificate, which is worse
# than none. That is POD-746's class, and write-web-build-stamp.ts refuses to
# stamp for the same reason.
#
# THE SHAPE: per-entry symlinks to the shared install (so no 800-package
# install is duplicated on a box that has fallen over for memory before), with
# @podium/* and .bin repointed at THIS worktree. Idempotent; safe to re-run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SHARED="${1:-/home/mgw/src/podium}"

[ -d "$SHARED/node_modules" ] || { echo "no shared install at $SHARED/node_modules"; exit 1; }
if [ -e "$REPO/node_modules/@podium/client-core" ]; then
  target="$(readlink -f "$REPO/node_modules/@podium/client-core")"
  if [ "$target" = "$(readlink -f "$REPO/packages/client-core")" ]; then
    echo "node_modules already points @podium at this worktree"
    exit 0
  fi
fi

mkdir -p "$REPO/node_modules"
# Everything third-party: one symlink per entry to the shared install.
for entry in "$SHARED"/node_modules/*; do
  name="$(basename "$entry")"
  [ "$name" = "@podium" ] && continue
  [ "$name" = ".bin" ] && continue
  [ -e "$REPO/node_modules/$name" ] && continue
  ln -s "$entry" "$REPO/node_modules/$name"
done
# Scoped dirs other than @podium: link the scope directory whole.
for entry in "$SHARED"/node_modules/@*; do
  name="$(basename "$entry")"
  [ "$name" = "@podium" ] && continue
  [ -e "$REPO/node_modules/$name" ] && continue
  ln -s "$entry" "$REPO/node_modules/$name"
done

# .bin as a real directory of symlinks, so `vite` resolves but nothing writes
# into the shared install.
mkdir -p "$REPO/node_modules/.bin"
for bin in "$SHARED"/node_modules/.bin/*; do
  name="$(basename "$bin")"
  [ -e "$REPO/node_modules/.bin/$name" ] && continue
  ln -s "$bin" "$REPO/node_modules/.bin/$name"
done

# @podium: THIS worktree's own packages and apps, which is the whole point.
rm -rf "$REPO/node_modules/@podium"
mkdir -p "$REPO/node_modules/@podium"
for pkg in "$REPO"/packages/*/package.json "$REPO"/apps/*/package.json; do
  dir="$(dirname "$pkg")"
  name="$(sed -n 's/.*"name": *"@podium\/\([^"]*\)".*/\1/p' "$pkg" | head -1)"
  [ -n "$name" ] || continue
  ln -sfn "$dir" "$REPO/node_modules/@podium/$name"
done

echo "node_modules linked: third-party shared from $SHARED, @podium local to $REPO"
ls -l "$REPO/node_modules/@podium" | head -5
