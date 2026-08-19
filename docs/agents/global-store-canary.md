# Bun global-store canary

This lane evaluates Bun 1.3.14's isolated global store without changing the repository
default. It installs only into detached worktrees that it creates under an explicit scratch
parent. The tracked bunfig.toml remains hoisted.

Run the lane separately on each target Linux host:

    bun run deps:canary-global-store -- \
      --cache-root /home/mgw/.cache/podium/bun-global-store-canary \
      --scratch-parent /home/mgw/.cache/podium/bun-global-store-canary-worktrees \
      --divergent-ref <commit-with-a-different-bun.lock> \
      --fleet-size <installed-worktree-count> \
      --run-id <unique-host-and-date-label> \
      --output <path-inside-this-issue-worktree>.json

The source checkout must be clean and the selected refs must already exist locally. The
runner requires /home/mgw/.bun/bin/bun to report exactly 1.3.14; use --bun only when
that same version is installed elsewhere. Each run-id is single-use.

## Isolation and cache contract

The runner creates four detached worktrees: hoisted control, current-lock candidate,
current-lock concurrent writer, and divergent-lock concurrent writer. It passes an
untracked generated config to candidate installs:

    [install]
    exact = false
    linker = "isolated"
    globalStore = true
    linkWorkspacePackages = true

All installs use --frozen-lockfile and an explicit cache under
<cache-root>/runs/<run-id>/. The hoisted control, candidate store, and initially empty
concurrency store have separate cache directories. The runner refuses the production Bun
cache, a cache inside the checkout, a scratch parent inside the checkout, or an existing
run directory. The canonical cache root and scratch parent must be on the same filesystem;
this is required for Bun's hardlink backend and valid physical-usage evidence, so tmpfs paths
such as /tmp and /dev/shm must not be paired with the durable home cache. It removes only the
detached worktrees it created; the dedicated caches and JSON evidence remain durable and are
never cleared by the lane.

Clean and warm timings are measured in the same worktree. Between them the runner invokes
deps:clean-local-installs, the Stage 0 repository-scoped cleanup, so every workspace
node_modules tree is removed without following symlinks or touching the cache.

## Recorded probes

The JSON report records:

- clean and warm frozen-install time and lockfile SHA-256 for hoisted and candidate layouts;
- the workspace resolution census, which rejects every @podium resolution outside its
  checkout;
- isolated Turbo typecheck cold and warm runs, the normal bun run test, the focused
  runtime-resolution suite, and the stable root systemd artifact diff;
- Vite/web build, Expo web export, desktop preflight, and tauri info;
- apparent, allocated, unique, and hardlink-shared bytes for each cache and root install;
- a fleet projection that counts cache inodes once and scales only worktree-exclusive
  physical bytes;
- global-store metadata digests before and after read-only/build probes;
- project-local .bun directory entries, broken symlinks, and staging residue;
- concurrent current/divergent installs into an initially empty shared store;
- cleanup, hoisted reinstall, local resolution, and unchanged candidate-store digest during
  rollback.

The byte accounting uses lstat device/inode identity instead of adding du totals.
uniqueAllocatedBytes is allocation whose inode has one link; sharedAllocatedBytes is
allocation whose inode has multiple links. The fleet projection is cache physical plus
fleet size times checkout-exclusive physical; inodes shared with the cache are charged once.

## Acceptance and interpretation

The command exits nonzero after writing its report if any mandatory acceptance field is
false. The candidate must keep the default and all lockfiles unchanged; pass every command
and resolution probe; leave no broken symlink or staging directory; preserve store metadata
through workflows and rollback; survive concurrent divergent writers; reinstall warm in no
more than 120% of the hoisted warm time; and project below the hoisted fleet footprint.

Bun intentionally keeps patched packages, packages with trusted lifecycle scripts, and
clusters involving workspace/file/link dependencies project-local rather than publishing
them into the global store. The report lists those .bun directory entries. They are an
explained exclusion class, not a failure, provided resolution stays checkout-local and the
fleet projection remains below the control.

The runner prepends the pinned Bun directory to child PATH and, when Cargo exists in the
operator's standard ~/.cargo/bin directory, preserves that toolchain for the desktop
preflight. A nonstandard Cargo installation must already be present on the invocation PATH.

Rollback does not clear the candidate cache. It runs Stage 0 cleanup in the disposable
candidate worktree, performs a frozen hoisted install against the dedicated hoisted cache,
repeats the workspace-resolution census, checks broken links, and requires the candidate
store's metadata digest to remain unchanged.
