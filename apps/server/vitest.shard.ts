import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedVitestConfig } from '../../vitest.config'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

interface ShardManifest {
  shards: { id: string; title: string; testFiles: string[] }[]
}

const manifest = JSON.parse(
  readFileSync(new URL('./test-shards.json', import.meta.url), 'utf8'),
) as ShardManifest

/**
 * Build the Vitest config for one @podium/server cache shard (POD-520).
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
  return defineConfig({
    root: repositoryRoot,
    resolve: sharedVitestConfig.resolve,
    test: {
      ...sharedVitestConfig.test,
      name: `server:${shardId}`,
      include: shard.testFiles,
      passWithNoTests: false,
      // Hermetic lane: a flaky unit test is a bug, not weather.
      retry: 0,
      ...(serialized ? { fileParallelism: false, maxWorkers: 1 } : {}),
    },
  })
}

export const shardIds = (): string[] => manifest.shards.map((shard) => shard.id)
