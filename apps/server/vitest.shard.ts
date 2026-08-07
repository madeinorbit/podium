import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'
import { shardMayReuse, splitForReuse } from './src/test-support/reuse-plan'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

interface ShardManifest {
  shards: { id: string; title: string; testFiles: string[] }[]
}

const manifest = JSON.parse(
  readFileSync(new URL('./test-shards.json', import.meta.url), 'utf8'),
) as ShardManifest

/** The reused project's extra setupFile, resolved the way `sharedVitestConfig` writes its own. */
export const REUSE_GUARD_SETUP_FILE = './test-hermetic-reuse-guard.ts'

/** Vitest project names for a shard that splits by reuse eligibility. */
export const reusedProjectName = (shardId: string) => `server:${shardId}:reused`
export const isolatedProjectName = (shardId: string) => `server:${shardId}:isolated`

/**
 * Build the Vitest config for one @podium/server cache shard (POD-520, POD-527).
 *
 * The shard runs an EXPLICIT file list read from `test-shards.json`, not a glob. That is
 * deliberate: the file list and the shard's Turbo `inputs` are derived together from the
 * same import-closure scan (scripts/server-test-shards.ts), so a glob that drifted from
 * the manifest would run files the cache key never accounted for — the false green this
 * whole split has to avoid. `passWithNoTests: false` closes the other end: an empty shard
 * means the manifest and the filesystem disagree, and that must be a failure, not a pass.
 *
 * Everything hermetic comes from `sharedVitestConfig` unchanged — the env scrubber, the
 * vitest hooks, POD-523's pre-migrated store setupFile and schema-image globalSetup, the
 * two-worker cap for the shared host, and the 20s timeout. A shard that diverged from any
 * of those would be a different lane wearing the lane's name; scripts/test-configuration.test.ts
 * asserts it has not.
 *
 * ## Runner reuse [POD-527]
 *
 * The installed Vitest reuses a completed runner only when `task.isolate` is false, and
 * `isolate` is a PROJECT-level option — so a shard that opts in becomes two projects rather
 * than two invocations. The reused project takes the files that pass the static scan in
 * `src/test-support/reuse-plan.ts`, drops isolation, and adds the after-file leak guard; the
 * isolated project takes the rest and runs exactly as it did before. Both are in one Vitest
 * run, one Turbo task and one cache unit, so the shard's roster is still the manifest's
 * roster — `verify()` in scripts/server-test-shards.ts keeps checking the union.
 *
 * Two projects rather than one config with a filtered `include` is what keeps the demoted
 * files running. Reuse is not a reason to stop testing something, and a shard whose include
 * silently shed 8 files would be the same false green the split was built to refuse.
 *
 * Reuse is gated on the shard id, not on the scan: `store`, `services` and `boundary`
 * compose the application and stay fully isolated regardless of how clean an individual
 * file reads.
 */
export const createServerShardConfig = (shardId: string) => {
  const shard = manifest.shards.find((candidate) => candidate.id === shardId)
  if (!shard) {
    throw new Error(
      `unknown @podium/server test shard "${shardId}" — known: ` +
        `${manifest.shards.map((candidate) => candidate.id).join(', ')}. ` +
        'Regenerate with: bun scripts/server-test-shards.ts --write',
    )
  }
  // The wire guards measure operation counts under concurrent load, so they keep the root
  // lane's one-worker serialization. Sharding gives them their own cache unit; it must not
  // change how they run (POD-515 Keep item 5).
  const serialized = shardId === 'normalized-wire'
  const shardTestOptions = {
    ...sharedVitestConfig.test,
    passWithNoTests: false,
    // Hermetic lane: a flaky unit test is a bug, not weather.
    retry: 0,
    ...(serialized ? { fileParallelism: false, maxWorkers: 1 } : {}),
  }

  const split = shardMayReuse(shardId)
    ? splitForReuse(shard.testFiles, repositoryRoot)
    : { reusable: [], isolated: shard.testFiles }

  // A shard is only worth splitting into projects when the scan actually promoted something.
  // If every file were demoted the reused project would be empty, and `passWithNoTests:
  // false` would then turn "nothing is currently reuse-safe" into a red lane.
  if (split.reusable.length === 0) {
    return defineConfig({
      root: repositoryRoot,
      resolve: sharedVitestConfig.resolve,
      test: { ...shardTestOptions, name: `server:${shardId}`, include: shard.testFiles },
    })
  }

  return defineConfig({
    root: repositoryRoot,
    resolve: sharedVitestConfig.resolve,
    test: {
      ...shardTestOptions,
      name: `server:${shardId}`,
      // NO root-level `include` here, and it is not an omission. Vitest resolves a
      // root-level `include` ahead of each project's own, so leaving the shard roster here
      // made BOTH projects collect all 70 files — every test ran twice and isolation was
      // decided by whichever project got there first. The roster now lives only in the two
      // project includes, whose union `scripts/server-test-reuse.test.ts` checks against the
      // manifest.
      projects: [
        {
          extends: true,
          test: {
            ...shardTestOptions,
            name: reusedProjectName(shardId),
            include: split.reusable,
            // The one line this whole issue is about. Vitest's pool hands a finished runner
            // to the next queued file only when both carry `isolate: false`, and the worker
            // then skips the module-registry and mocker resets it does between isolated
            // files — which is where the import/collect time goes and why the leak guard
            // below is not optional.
            isolate: false,
            setupFiles: [...sharedVitestConfig.test.setupFiles, REUSE_GUARD_SETUP_FILE],
          },
        },
        // Emitted only when the scan actually demoted something. An empty project would
        // otherwise have to carry `passWithNoTests: true` to avoid failing the lane, and
        // that is the one exemption this shard cannot afford: `passWithNoTests: false` is
        // how a manifest that disagrees with the filesystem shows up as red.
        ...(split.isolated.length === 0
          ? []
          : [
              {
                extends: true as const,
                test: {
                  ...shardTestOptions,
                  name: isolatedProjectName(shardId),
                  include: split.isolated,
                  // Demoted files are demoted, not dropped. Same shard, same cache unit,
                  // same fork-per-file they have always had.
                  isolate: true,
                },
              },
            ]),
      ],
    },
  })
}

export const shardIds = (): string[] => manifest.shards.map((shard) => shard.id)
