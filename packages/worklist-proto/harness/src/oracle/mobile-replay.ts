/** In-memory operator replay, restricted to ludovico. Only counts, positions,
 * field names and opaque issue IDs are emitted; no export is ever written.
 * timeout 180s bun --conditions=@podium/source packages/worklist-proto/harness/src/oracle/mobile-replay.ts --live
 */
import { hostname } from 'node:os'
import { runInAction } from 'mobx'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { legacyDerivationFromStore } from '@podium/client-graph/diagnostics/legacy'
import { readLive } from '../fixture/export-snapshot'
import { corpusFromLive } from '../fixture/live-snapshot'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { sidebarReplayStore } from './sidebar-replay'
import { checkMobile, poolMobileSnapshot } from './mobile'

async function main(): Promise<void> {
  if (hostname() !== 'ludovico' || !process.argv.includes('--live')) throw new Error('Local live replay only')
  const { raw } = await readLive('http://127.0.0.1:18787')
  const corpus = { ...corpusFromLive(raw, Date.now()), issueProjections: raw.issueProjections,
    issueUserStates: raw.issueUserStates ?? [], issueGitStates: raw.issueGitStates ?? [], repoProjections: raw.repoProjections }
  const replica = createKernelReplica({ cache: seedCacheFromCorpus(corpus),
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const store = sidebarReplayStore(corpus, replica)
  const runtime = { getSnapshot: () => store, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map() }
  const rows = createRowSource(runtime, replica, { mode: 'overlaid' })
  const locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source)
  const state = { pinnedRepos: corpus.pins.repos, pinnedWorktrees: corpus.pins.worktrees }
  try {
    let settled = false
    for (let window = 0; window < 64; window += 1) {
      runInAction(() => poolMobileSnapshot(handle.pool, state))
      if (handle.pool.hydrate() === 0) { settled = true; break }
    }
    if (!settled) throw new Error('Replay did not settle')
    const result = runInAction(() => checkMobile(handle.pool, legacyDerivationFromStore(store, handle.pool.clock.current), state))
    const opaque = (id: string | null) => id && /^iss_[\w-]+$/.test(id) ? id : null
    console.log(JSON.stringify({ issues: corpus.issueProjections.length, sessions: corpus.sessions.length,
      sections: result.sections, rows: result.rows, differences: result.differences, pending: result.pending,
      first: result.first ? { sectionIndex: result.first.sectionIndex, rowIndex: result.first.rowIndex,
        field: result.first.field, expectedId: opaque(result.first.expectedId), actualId: opaque(result.first.actualId) } : null }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose(); locals.dispose(); rows.dispose() }
}

if (import.meta.main) {
  try { await main() } catch { console.error('Mobile replay failed; operator data and error details suppressed'); process.exitCode = 1 }
}
