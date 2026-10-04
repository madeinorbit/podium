/** Ludovico-only, read-only replay. Authored values stay in this process;
 * output contains counts, field positions and opaque issue IDs only. */
import { hostname } from 'node:os'
import { runInAction } from 'mobx'
import { dedupeSessions } from '@podium/client-core/engine'
import { allIssueViewModels, createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkIssuePages, ISSUE_PAGE_CHECK_FIELDS, SESSION_FIELDS, poolIssuePageSnapshot, type IssuePageDifference } from '@podium/client-graph/diagnostics/issue-page-check'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { sessionUserStateRowId } from '@podium/model'
import type { FixtureCorpus } from '../fixture'
import { fixtureSessionHomes, stripSessionLegacy } from '../fixture/session-homes'
import { readLive } from '../fixture/export-snapshot'
import { corpusFromLive } from '../fixture/live-snapshot'
import { sidebarReplayStore } from './sidebar-replay'
import { withKeyedInputs } from '@podium/client-core/engine'

let step = 0
function phase(next: number) {
  step = next
  console.log(JSON.stringify({ phase: step }))
}
export function replayIssuePages(corpus: FixtureCorpus) {
  // Match the established scenario/browser seed: canonical session metadata
  // and its personal/machine homes, rather than computed cells in raw storage.
  const homes = fixtureSessionHomes(corpus, corpus.issueUserStates?.[0]?.userId ?? 'operator')
  const cache = seedCacheFromCorpus({ ...corpus, sessions: homes.sessions.map(stripSessionLegacy) })
  cache.install([
    ...homes.userStates.map(value => ({ entity: 'sessionUserState' as const,
      entityId: sessionUserStateRowId(value.userId, value.sessionId), value })),
    ...homes.machines.map(value => ({ entity: 'machine' as const, entityId: value.id, value })),
  ])
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const store = sidebarReplayStore(corpus, replica)
  const viewsById = new Map(corpus.sessions.map(row => [row.sessionId, row]))
  const ordered = replica.rows('sessions').map(row => {
    const value = viewsById.get(row.sessionId)
    if (!value) throw new Error('Missing replay session view')
    return value
  })
  store.sessions = dedupeSessions(ordered)
  const runtime = withKeyedInputs({ getSnapshot: () => store, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map() })
  phase(3)
  const rows = createRowSource(runtime, replica, { mode: 'overlaid' }), locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source, { summaries: ISSUE_PAGE_SUMMARIES })
  try {
    for (let round = 0; round < 64; round++) {
      runInAction(() => poolIssuePageSnapshot(handle.pool))
      if (handle.pool.hydrate() === 0) break
    }
    phase(4)
    const locations: IssuePageDifference[] = []
    const result = runInAction(() => checkIssuePages(handle.pool,
      allIssueViewModels(replica, store.issueProjections, store.issueUserStates), store.sessions, diff => locations.push(diff)))
    return { result, locations }
  } finally { handle.dispose(); locals.dispose(); rows.dispose() }
}
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Wrong replay host')
  phase(1)
  const { raw, bootstrapEntityCounts } = await readLive('http://127.0.0.1:18787')
  phase(2)
  const corpus = { ...corpusFromLive(raw, Date.now()), issueProjections: raw.issueProjections,
    issueUserStates: raw.issueUserStates ?? [], issueGitStates: raw.issueGitStates ?? [], repoProjections: raw.repoProjections }
  const { result, locations } = replayIssuePages(corpus)
  const safe = (diff: IssuePageDifference) => {
    const parts = diff.field.split('.')
    const sectionPosition = ['fields', 'children', 'members', 'roster', 'moved', 'relations'].indexOf(parts[0] ?? '')
    const fields: readonly string[] = sectionPosition < 2 ? ISSUE_PAGE_CHECK_FIELDS : SESSION_FIELDS
    return { issueId: /^iss_[\w-]+$/.test(diff.issueId) ? diff.issueId : null, position: diff.position,
      sectionPosition, fieldPosition: fields.indexOf(parts[sectionPosition === 0 ? 1 : 2] ?? ''),
      valuePositions: parts.filter(part => /^\d+$/.test(part)).map(Number) }
  }
  const counts = new Map<string, number>()
  for (const diff of locations) {
    const { sectionPosition, fieldPosition } = safe(diff)
    const key = `${sectionPosition}:${fieldPosition}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
    // Kind names are schema vocabulary; only their counts leave the process.
    console.log(JSON.stringify({ inputCounts: Object.values(bootstrapEntityCounts), issues: result.issues,
      positions: result.positions, differences: result.differences, pending: result.pending,
      acceptedDeadlineDifferences: result.acceptedDeadlineDifferences,
      first: result.first ? safe(result.first) : null,
      locationCounts: [...counts].map(([key, count]) => ({ positions: key.split(':').map(Number), count })),
      locations: locations.slice(0, 10).map(safe) }))
    if (result.differences || result.pending) process.exitCode = 1
}
if (import.meta.main) main().catch(() => {
  console.log(JSON.stringify({ failed: 1, step }))
  process.exitCode = 1
})
