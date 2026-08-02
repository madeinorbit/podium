# POD-1378 — cache-key coverage evidence

Measured 2026-08-02 on `edfd5d04` in worktree
`issue-1378-cached-checks-by-default-uncached-only-w`, turbo 2.10.5, after a fresh
`bun install` (25 `node_modules/@podium` links). The probe instrument is
`turbo run typecheck --dry=json`: it performs the real cache lookup (per-task
`cache.status` HIT/MISS) without executing anything. Instrument validated both ways
before use: default cache → 22/22 HIT; `TURBO_CACHE_DIR=<empty dir>` → 0/25 HIT.

## The two mechanisms (question 1)

- **Cached typecheck (the default):** `bun run typecheck` → `scripts/typecheck.ts`
  → `turbo run typecheck`. 22 packages, ~2s on full hit ("FULL TURBO").
- **Uncached typecheck (deliberate):**
  `bun run typecheck -- --uncached-because="<reason>"` → forwards `--force` to
  turbo. ~3m14s (measured by the POD-279 coordinator; 110x). Equivalent turbo
  spellings — `--force`, `TURBO_FORCE=1`, and read-disabled `--cache=` values such
  as `local:w,remote:w` — are all detected by the wrapper and refused without a
  reason. `--no-cache` is NOT an uncached path: in turbo 2.10 it means
  `--cache=local:r,remote:r` (still reads, skips writes). No task sets
  `"cache": false` in `turbo.json`.
- **Tests have no split.** Every `test*` script runs vitest / `bun test` directly;
  none is a turbo task, so every test run is always uncached and `--force` is
  meaningless there.

## Change-type vs hit/miss (question 2)

Baseline throughout: 22 cacheable tasks HIT, 3 MISS-reported tasks are packages
with no `typecheck` command (not cacheable). Each probe: make the change, run the
dry-run lookup, restore, confirm return to baseline.

| Change | Command used | Result (pre-fix) | Covered? |
| --- | --- | --- | --- |
| None (baseline) | `turbo run typecheck --dry=json` | 22/22 HIT | — |
| `bun.lock` +1 trailing newline | append `\n`, dry-run, restore | **0 HIT / 25 MISS** | Yes — `globalDependencies` |
| Install that changes `package.json`/`bun.lock` | same key as above | MISS | Yes |
| `bunfig.toml` `linker = "hoisted"` → `"isolated"` (POD-1343 shape) | `sed` flip, dry-run, restore | **22/22 HIT — blind spot** | **No** (pre-fix); Yes post-fix via `PODIUM_CHECK_ENV_HASH` |
| `node_modules` layout / broken links | not hashed by turbo at all | HIT regardless (POD-1343: 22/22 green with 0 `@podium` links) | **No** (pre-fix); post-fix: census in env hash + hard refusal at 0 links |
| Git base swap in the same worktree (`edfd5d04` → `053d8137`, 11 files changed) | `git checkout --detach`, dry-run, compare per-task `hash` fields, return | all 16 comparable task hashes **moved**; 16/16 HIT against that commit's own earlier green runs, 0 stale reuse | Yes — content-keyed |

Two structural facts behind the blind spot:

1. Task inputs are `$TURBO_DEFAULT$` (tracked files per package) plus
   `globalDependencies` — root `bunfig.toml` and everything under `node_modules`
   are in neither, so the install environment was invisible to the key.
2. The local cache is shared across checkouts: this worktree had **no `.turbo`
   directory and a minutes-old `node_modules`** yet scored 22/22 HIT (artifacts
   stamped `sha: 40e2cac3`, produced by an earlier commit with an identical tree,
   served from the main checkout's `.turbo/cache`, 92MB / ~23k entries). A hit
   therefore proves "this content was green somewhere", not "this checkout can
   build" — which is why the environment must be part of the key and why a
   link-less checkout is refused rather than allowed to go green.

## Enforcement (question 3)

`scripts/typecheck.ts` is what `bun run typecheck` runs. It:

1. refuses to run at all when `node_modules/@podium` has no usable links
   (`bun install` first — POD-1343);
2. computes `PODIUM_CHECK_ENV_HASH` = sha256(`bunfig.toml` content + sorted
   `@podium` link census incl. dangling markers), declared in `turbo.json`
   `globalEnv`, so environment drift is an automatic MISS — the system notices by
   itself, no forcing habit needed;
3. rejects `--force` / `TURBO_FORCE` / read-disabled `--cache=` with an error that
   states the cost and names the escape hatch
   `--uncached-because="<reason>"` (also strips `TURBO_FORCE` from the child env
   so it cannot bypass the check).

Decision logic and fingerprint are unit-tested in `scripts/typecheck.test.ts`
(unit lane). Direct `./node_modules/.bin/turbo run typecheck` still bypasses the
wrapper — unenforceable without wrapping the binary itself — but no package.json
script exposes it.

## The rule (question 4)

> Run `bun run typecheck` and trust a cache hit. Never force. If you have a
> concrete reason to believe the cache is wrong, run
> `bun run typecheck -- --uncached-because="<reason>"` and file the gap.

Named exceptions that used to justify forcing, now auto-covered: dependency
installs (`bun.lock`/`package.json` in `globalDependencies`), `bunfig.toml`/linker
changes and `node_modules/@podium` drift (`PODIUM_CHECK_ENV_HASH`), git base swaps
(content-keyed task hashes), broken checkouts (refused outright).

## Post-fix verification (all live, same session)

| Check | Command | Observed |
| --- | --- | --- |
| One-time rekey (globalEnv addition invalidates once) | `bun run typecheck -- --concurrency=4` | 0 cached / 22, 2m17.7s wall |
| Cached run through wrapper | `bun run typecheck` | 22/22 cached, 773ms, FULL TURBO |
| Linker flip now noticed | flip `bunfig.toml`, `bun run typecheck -- --dry=json` | **0 HIT / 22** (was 22 HIT pre-fix) |
| Restore | restore, dry-run | 22/22 HIT |
| Bare force refused | `bun run typecheck --force` | exit 1, refusal message |
| Env force refused | `TURBO_FORCE=1 bun run typecheck` | exit 1 |
| Uninstalled checkout refused | `mv node_modules/@podium{,.bak}`, run, restore | exit 1, "run \`bun install\` first" |
| Reason escape hatch | `bun run typecheck -- --uncached-because="…"` | forwards `--force`, logs reason |
