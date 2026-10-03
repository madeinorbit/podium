/** In-memory operator replay, restricted to ludovico. Only counts, positions,
 * field names and opaque issue IDs are emitted; no export is ever written.
 * timeout 180s bun --conditions=@podium/source packages/worklist-proto/harness/src/oracle/mobile-replay.ts --live
 */
import { hostname } from 'node:os'
import { runInAction } from 'mobx'
import { dedupeSessions } from '@podium/client-core/engine'
import { sessionViews } from '@podium/client-core/session-values'
import { sessionUserStateRowId } from '@podium/model'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { legacyDerivationFromStore } from '@podium/client-graph/diagnostics/legacy'
import { checkSidebar, type SidebarDifference } from '@podium/client-graph/diagnostics/sidebar-check'
import { readLive } from '../fixture/export-snapshot'
import { corpusFromLive } from '../fixture/live-snapshot'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { sidebarReplayStore } from './sidebar-replay'
import { checkMobile, legacyMobileSnapshot, poolMobileSnapshot } from './mobile'

async function main(): Promise<void> {
  if (hostname() !== 'ludovico' || !process.argv.includes('--live')) throw new Error('Local live replay only')
  const { raw, sessionHomes, snapshotSeq } = await readLive('http://127.0.0.1:18787')
  const corpus = { ...corpusFromLive(raw, Date.now()), issueProjections: raw.issueProjections,
    issueUserStates: raw.issueUserStates ?? [], issueGitStates: raw.issueGitStates ?? [], repoProjections: raw.repoProjections }
  const cache = seedCacheFromCorpus(corpus)
  cache.install([
    ...sessionHomes.sessions.map(value => ({ entity: 'session' as const, entityId: value.sessionId, value })),
    ...sessionHomes.userStates.map(value => ({ entity: 'sessionUserState' as const,
      entityId: sessionUserStateRowId(value.userId, value.sessionId), value })),
    ...sessionHomes.machines.map(value => ({ entity: 'machine' as const, entityId: value.id, value })),
  ])
  const replica = createKernelReplica({ cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'cold-start', snapshotSeq,
    entityCount: cache.records.length, bufferedFramesApplied: 0 })
  const store = sidebarReplayStore(corpus, replica)
  // Same read view and resume-collapse order as ClientRuntime.readSessionViews.
  store.sessions = dedupeSessions(sessionViews(replica.rows('sessions'), {
    userId: sessionHomes.userId, userStatesLoaded: true, userStates: replica.rows('sessionUserStates'),
    repos: replica.rows('repos'), machines: replica.rows('machines'),
  }))
  const runtime = { principal: { userId: sessionHomes.userId }, getSnapshot: () => store,
    subscribe: () => () => {}, pendingOverlaysByRow: () => new Map() }
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
    const derivation = legacyDerivationFromStore(store, handle.pool.clock.current)
    const locations: SidebarDifference[] = []
    const result = runInAction(() => checkMobile(handle.pool, derivation, state, difference => locations.push(difference)))
    const opaque = (id: string | null) => id && /^iss_[\w-]+$/.test(id) ? id : null
    const safeLocation = (difference: SidebarDifference) => ({ sectionIndex: difference.sectionIndex,
      rowIndex: difference.rowIndex, field: difference.field,
      expectedId: opaque(difference.expectedId), actualId: opaque(difference.actualId) })
    const fields = Object.fromEntries([...new Set(locations.map(location => location.field))]
      .map(field => [field, locations.filter(location => location.field === field).length]))
    const expected = legacyMobileSnapshot(derivation, state)
    const actual = runInAction(() => poolMobileSnapshot(handle.pool, state))
    const sidebar = runInAction(() => checkSidebar(handle.pool, store, state))
    console.log(JSON.stringify({ issues: corpus.issueProjections.length, sessions: corpus.sessions.length,
      sections: result.sections, rows: result.rows, differences: result.differences, pending: result.pending,
      first: result.first ? safeLocation(result.first) : null,
      ...(result.differences ? { fields, locations: locations.slice(0, 20).map(safeLocation),
        expectedCounts: expected.sections[0]!.fields, actualCounts: actual.sections[0]!.fields,
        expectedBandRows: expected.sections.map(section => section.rows.length), actualBandRows: actual.sections.map(section => section.rows.length),
        sidebar: { differences: sidebar.differences, pending: sidebar.pending, field: sidebar.first?.field ?? null } } : {}) }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose(); locals.dispose(); rows.dispose() }
}

if (import.meta.main) {
  try { await main() } catch { console.error('Mobile replay failed; operator data and error details suppressed'); process.exitCode = 1 }
}
