/**
 * Which store-shard test files run on which engine [POD-6980, POD-6958 design 2.10].
 *
 * `apps/server/test-store-engines.json` names the exceptions; this module reads it
 * and derives the Postgres leg's file list from the store shard's roster in
 * `apps/server/test-shards.json`. Read by `vitest.store-pg.config.ts` and checked by
 * `src/store/test-store-engines.test.ts`. No database, no store imports.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Imported, not read from disk, so the shard scan lists the file as an input of every
// shard that runs this module and an edit to the lists invalidates their cache.
import enginesFile from '../../test-store-engines.json'

export interface TestStoreEngines {
  /** File → why it tests SQLite itself and never runs on Postgres. */
  readonly sqliteOnly: Readonly<Record<string, string>>
  /** Files meant for both engines that do not pass on Postgres yet. */
  readonly pending: readonly string[]
  /**
   * File → why a test OUTSIDE the store shard also runs on the Postgres leg: a
   * boot-wiring file, or a server started on a Postgres URL [POD-6994].
   */
  readonly beyondStoreShard: Readonly<Record<string, string>>
}

interface ShardManifest {
  shards: { id: string; testFiles: string[] }[]
}

export function readTestStoreEngines(): TestStoreEngines {
  const raw = enginesFile as Partial<TestStoreEngines>
  return {
    sqliteOnly: raw.sqliteOnly ?? {},
    pending: raw.pending ?? [],
    beyondStoreShard: raw.beyondStoreShard ?? {},
  }
}

/** The store shard's files, repository-relative, as `test-shards.json` lists them. */
export function storeShardFiles(repositoryRoot: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'apps/server/test-shards.json'), 'utf8'),
  ) as ShardManifest
  const store = manifest.shards.find((shard) => shard.id === 'store')
  if (store === undefined) throw new Error('apps/server/test-shards.json has no store shard')
  return store.testFiles
}

/**
 * The Postgres audits outside the store shard [POD-6992]: `*.pg.test.ts` files of any other
 * shard. A Postgres audit that reads the source tree (the query-plan audit reads every
 * definition site) is a boundary-shard file by the shard rules, and it runs only here.
 */
export function postgresAuditFiles(repositoryRoot: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'apps/server/test-shards.json'), 'utf8'),
  ) as ShardManifest
  return manifest.shards
    .filter((shard) => shard.id !== 'store')
    .flatMap((shard) => shard.testFiles)
    .filter((file) => file.endsWith('.pg.test.ts'))
}

/**
 * Set to `pending` to run only the pending files on the Postgres leg [POD-6994]: what a
 * task converting files runs to see which of them pass now (and leave the list).
 */
export const PG_LEG_SELECTION_ENV = 'PODIUM_TEST_STORE_PG_LEG'

/**
 * The files the Postgres leg runs: the store shard minus both lists, the Postgres audits,
 * and `beyondStoreShard`.
 */
export function postgresLegFiles(
  repositoryRoot: string,
  engines: TestStoreEngines = readTestStoreEngines(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (env[PG_LEG_SELECTION_ENV] === 'pending') return [...engines.pending]
  const excluded = new Set([...Object.keys(engines.sqliteOnly), ...engines.pending])
  return [
    ...storeShardFiles(repositoryRoot).filter((file) => !excluded.has(file)),
    ...postgresAuditFiles(repositoryRoot),
    ...Object.keys(engines.beyondStoreShard),
  ]
}

/** What is wrong with the lists, one line per problem; empty when they are sound. */
export function testStoreEngineProblems(
  engines: TestStoreEngines,
  storeFiles: readonly string[],
  exists: (file: string) => boolean = () => true,
): string[] {
  const roster = new Set(storeFiles)
  const problems: string[] = []
  for (const [file, reason] of Object.entries(engines.sqliteOnly)) {
    if (!roster.has(file))
      problems.push(`sqliteOnly names ${file}, which is not a store-shard file`)
    if (reason.trim().length < 20) problems.push(`sqliteOnly ${file} needs a reason`)
  }
  const seen = new Set<string>()
  for (const file of engines.pending) {
    if (!roster.has(file)) problems.push(`pending names ${file}, which is not a store-shard file`)
    if (file in engines.sqliteOnly) problems.push(`${file} is both sqliteOnly and pending`)
    if (seen.has(file)) problems.push(`pending lists ${file} twice`)
    seen.add(file)
  }
  for (const [file, reason] of Object.entries(engines.beyondStoreShard)) {
    if (roster.has(file)) {
      problems.push(`beyondStoreShard names ${file}, which is a store-shard file`)
    }
    if (!exists(file)) problems.push(`beyondStoreShard names ${file}, which does not exist`)
    if (reason.trim().length < 20) problems.push(`beyondStoreShard ${file} needs a reason`)
  }
  return problems
}
