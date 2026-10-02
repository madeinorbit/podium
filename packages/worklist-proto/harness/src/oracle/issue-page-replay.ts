/** Ludovico-only, read-only replay. Authored values stay in this process;
 * output contains counts, field positions and opaque issue IDs only. */
import { hostname } from 'node:os'
import { runInAction } from 'mobx'
import { allIssueViewModels, createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkIssuePages, ISSUE_PAGE_CHECK_FIELDS, poolIssuePageSnapshot, type IssuePageDifference } from '@podium/client-graph/diagnostics/issue-page-check'
import { ISSUE_PAGE_SUMMARIES } from '@podium/client-graph/issue-page-schema'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { readLive } from '../fixture/export-snapshot'
import { corpusFromLive } from '../fixture/live-snapshot'
import { sidebarReplayStore } from './sidebar-replay'

let step = 0
function phase(next: number) {
  step = next
  console.log(JSON.stringify({ phase: step }))
}
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Wrong replay host')
  phase(1)
  const { raw, bootstrapEntityCounts } = await readLive('http://127.0.0.1:18787')
  phase(2)
  const corpus = { ...corpusFromLive(raw, Date.now()), issueProjections: raw.issueProjections,
    issueUserStates: raw.issueUserStates ?? [], issueGitStates: raw.issueGitStates ?? [], repoProjections: raw.repoProjections }
  const cache = seedCacheFromCorpus(corpus)
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const store = sidebarReplayStore(corpus, replica)
  const runtime = { getSnapshot: () => store, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map() }
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
    const safe = (diff: IssuePageDifference) => ({
      issueId: /^iss_[\w-]+$/.test(diff.issueId) ? diff.issueId : null,
      position: diff.position,
      fieldPosition: ISSUE_PAGE_CHECK_FIELDS.indexOf(diff.field.split('.')[1] as typeof ISSUE_PAGE_CHECK_FIELDS[number]),
      valuePositions: diff.field.split('.').filter(part => /^\d+$/.test(part)).map(Number),
    })
    // Kind names are schema vocabulary; only their counts leave the process.
    console.log(JSON.stringify({ inputCounts: Object.values(bootstrapEntityCounts), issues: result.issues,
      positions: result.positions, differences: result.differences, pending: result.pending,
      acceptedDeadlineDifferences: result.acceptedDeadlineDifferences,
      first: result.first ? safe(result.first) : null, locations: locations.map(safe) }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose(); locals.dispose(); rows.dispose() }
}
if (import.meta.main) main().catch(() => {
  console.log(JSON.stringify({ failed: 1, step }))
  process.exitCode = 1
})
