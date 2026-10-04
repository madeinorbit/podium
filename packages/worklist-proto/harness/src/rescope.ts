/**
 * POD-4572 (Mb4, coordinator ruling 2026-09-24) — staging a rescope the way a
 * real one arrives: the new scope's kernel ROWS and its worktree SCANS.
 *
 * Until this module the browser page's rescope (L5e, `harness/web/entrylib.ts`)
 * staged the grown corpus's rows only; discovery kept answering the page's own
 * corpus, so at the grown state every worktree the grown corpus adds was
 * unscanned. The legacy oracle seats a session under an issue's own
 * `worktreePath` whether or not a scan reported it; the schema's R3 relation
 * does not (POD-4671), so seven 2x issues differed from the oracle and an arm
 * could only pass with its exception widened. The page and the count lane
 * (`rescope.test.ts`) now stage through these functions, so both install the
 * same thing.
 *
 * - `stageScans` sets what discovery answers and pushes `worktreesChanged`
 *   (the server's push, `scenarios.ts` `FakeHub`), then waits until the
 *   runtime has published those repos. It is a publication the arm sees.
 * - `stageRows` makes the kernel cache exactly `rows`, inside one replica
 *   batch; `fireRescope` is the kernel's rescope install over it
 *   (methodology #13), the step the page times.
 */

import type { ScenarioEngine } from '../../shared/src/scenarios'
import { FIXTURE_SEED, seedCacheFromCorpus } from '../../shared/src/scenarios'
import { buildCorpus, type FixtureCorpus } from './fixture/index'

type CacheRecords = ScenarioEngine['cache']['records']
type Entity = Parameters<ScenarioEngine['cache']['put']>[0]

/** One scope's worth of staging: its corpus, kernel rows and discovery answer. */
export interface StagedScope {
  readonly corpus: FixtureCorpus
  readonly rows: CacheRecords
  readonly repos: readonly unknown[]
}

/** The corpus at `scale` as a scope to stage. */
export function scopeOfCorpus(scale: 1 | 2 | 4): StagedScope {
  const corpus = buildCorpus(scale, FIXTURE_SEED)
  return { corpus, rows: seedCacheFromCorpus(corpus).records, repos: corpus.repos as unknown[] }
}

/** The scope `boot` holds now (to come back to). */
export function currentScope(boot: ScenarioEngine, corpus: FixtureCorpus): StagedScope {
  return { corpus, rows: [...boot.cache.records], repos: boot.discovery.repos }
}

/** The kernel cache becomes exactly `rows` (in their order), in one replica batch. */
export function stageRows(boot: ScenarioEngine, rows: CacheRecords): void {
  const { cache, replica } = boot
  const keep = new Set(rows.map((row) => `${row.entity}:${row.entityId}`))
  replica.batch(() => {
    for (const row of [...cache.records]) {
      if (!keep.has(`${row.entity}:${row.entityId}`)) cache.drop(row.entity as Entity, row.entityId)
    }
    for (const row of rows) cache.put(row.entity as Entity, row.entityId, row.value)
  })
}

/** Discovery answers `repos`; the server pushes `worktreesChanged`; resolves once the runtime published them. */
export async function stageScans(
  boot: ScenarioEngine,
  repos: readonly unknown[],
  timeoutMs = 5_000,
): Promise<void> {
  const answer = repos as unknown[]
  boot.discovery.repos = answer
  boot.hub.emit('worktreesChanged')
  const began = Date.now()
  while (boot.engine.access.repos !== answer) {
    if (Date.now() - began > timeoutMs) {
      throw new Error(`[rescope] discovery did not publish the staged scans in ${timeoutMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The kernel's rescope install over the cache as it stands (methodology #13). */
export function fireRescope(boot: ScenarioEngine, snapshotSeq: number): void {
  boot.replica.onKernelEvent({
    type: 'bootstrap-installed',
    cause: 'rescope',
    snapshotSeq,
    entityCount: boot.cache.records.length,
    bufferedFramesApplied: 0,
  } as never)
}
