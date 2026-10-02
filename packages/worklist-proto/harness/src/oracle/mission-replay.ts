/** Read-only operator replay, ludovico only. No input is saved or exported;
 * only counts, positions and opaque issue ids are printed. */
import { hostname } from 'node:os'
import { runInAction } from 'mobx'
import { allIssueViewModels, createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkMissions, poolMissionSnapshot, type MissionDifference } from '@podium/client-graph/diagnostics/mission-check'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { readLive } from '../fixture/export-snapshot'
import { corpusFromLive } from '../fixture/live-snapshot'
import { sidebarReplayStore } from './sidebar-replay'

async function main() {
  if (hostname() !== 'ludovico') throw new Error('Mission replay is restricted to ludovico')
  const { raw, bootstrapEntityCounts } = await readLive('http://127.0.0.1:18787')
  const corpus = { ...corpusFromLive(raw, Date.now()), issueProjections: raw.issueProjections,
    issueUserStates: raw.issueUserStates ?? [], issueGitStates: raw.issueGitStates ?? [], repoProjections: raw.repoProjections }
  const cache = seedCacheFromCorpus(corpus)
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const store = sidebarReplayStore(corpus, replica)
  const runtime = { getSnapshot: () => store, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map() }
  const rows = createRowSource(runtime, replica, { mode: 'overlaid' }), locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source, { summaries: MISSION_SUMMARIES })
  try {
    for (let round = 0; round < 64; round++) {
      runInAction(() => poolMissionSnapshot(handle.pool))
      if (handle.pool.hydrate() === 0) break
    }
    const locations: MissionDifference[] = []
    const result = runInAction(() => checkMissions(handle.pool,
      allIssueViewModels(replica, store.issueProjections, store.issueUserStates), store.sessions, diff => locations.push(diff)))
    const opaque = (id: string | null) => id && /^iss_[\w-]+$/.test(id) ? id : null
    const safe = (diff: MissionDifference) => ({ ...diff, issueId: opaque(diff.issueId), expectedId: opaque(diff.expectedId), actualId: opaque(diff.actualId) })
    console.log(JSON.stringify({ inputKinds: bootstrapEntityCounts, ...result,
      first: result.first ? safe(result.first) : null, locations: locations.map(safe) }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose(); locals.dispose(); rows.dispose() }
}
if (import.meta.main) main().catch(() => { console.log(JSON.stringify({ replay: 'failed' })); process.exitCode = 1 })
