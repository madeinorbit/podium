/** Offline export replay. Run on ludovico, never send the input elsewhere.
 * Only counts, opaque IDs and field locations are emitted. No raw snapshot,
 * diff values, error messages or worktree paths leave this process.
 * timeout 180s bun --conditions=@podium/source packages/worklist-proto/harness/src/oracle/sidebar-replay.ts --snapshot <file.json.gz>
 */
import { hostname } from 'node:os'
import type { PodiumClientApi } from '@podium/client-core/api'
import { dedupeSessions, type Store } from '@podium/client-core/engine'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkSidebar, poolSidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { runInAction } from 'mobx'
import { readSnapshot } from '../fixture/export-snapshot'
import { corpusFromLive } from '../fixture/live-snapshot'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'

function main(): void {
  if (hostname() !== 'ludovico') throw new Error('Operator export replay is restricted to ludovico')
  const path = process.argv[process.argv.indexOf('--snapshot') + 1]
  if (!process.argv.includes('--snapshot') || !path) throw new Error('Supply --snapshot')
  const snapshot = readSnapshot(path)
  const corpus = corpusFromLive(snapshot, Date.parse(snapshot.exportedAt))
  const replica = createKernelReplica({ cache: seedCacheFromCorpus(corpus), side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const store = { replica, issues: corpus.issues, issueProjections: corpus.issueProjections,
    sessions: dedupeSessions(corpus.sessions), repos: corpus.repos, machines: corpus.machines,
    pins: corpus.pins, coarseNow: corpus.fixedNow, selectedIssueId: null,
  } as unknown as Store<PodiumClientApi>
  const runtime = { getSnapshot: () => store, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map() }
  const rows = createRowSource(runtime, replica, { mode: 'overlaid' })
  const locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source)
  try {
    let settled = false
    for (let round = 0; round < 64; round += 1) {
      runInAction(() => poolSidebarSnapshot(handle.pool))
      if (handle.pool.hydrate() === 0) { settled = true; break }
    }
    if (!settled) throw new Error('Replay loading did not settle')
    const result = runInAction(() => checkSidebar(handle.pool, store, { pinnedRepos: corpus.pins.repos, pinnedWorktrees: corpus.pins.worktrees }))
    // Section/worktree identifiers can be paths. Omit them from the export report.
    const opaqueId = (id: string | null): string | null => id && /^iss_[\w-]+$/.test(id) ? id : null
    console.log(JSON.stringify({ issues: corpus.issues.length, sessions: corpus.sessions.length,
      sections: result.sections, rows: result.rows, differences: result.differences, pending: result.pending,
      first: result.first ? { sectionIndex: result.first.sectionIndex, rowIndex: result.first.rowIndex, field: result.first.field,
        expectedId: opaqueId(result.first.expectedId), actualId: opaqueId(result.first.actualId) } : null }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose(); locals.dispose(); rows.dispose() }
}
if (import.meta.main) {
  try { main() } catch { console.error('Sidebar export replay failed; input/error text withheld'); process.exitCode = 1 }
}
