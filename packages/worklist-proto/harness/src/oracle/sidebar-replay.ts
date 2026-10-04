/** Offline export replay. Run on ludovico, never send the input elsewhere.
 * Only counts, opaque IDs and field locations are emitted. No raw snapshot,
 * diff values, error messages or worktree paths leave this process.
 * --live reads once into memory without writing an export.
 * timeout 180s bun --conditions=@podium/source packages/worklist-proto/harness/src/oracle/sidebar-replay.ts --snapshot <file.json.gz>
 */

import { hostname } from 'node:os'
import type { PodiumClientApi } from '@podium/client-core/api'
import { withKeyedInputs } from '@podium/client-core/engine'
import { dedupeSessions } from '@podium/client-graph/diagnostics/reference-state'
import type { ReferenceState as Store } from '@podium/client-graph/diagnostics/reference-state'
import { createKernelReplica, createSideCache, memoryStorage, type Replica } from '@podium/client-core/replica'
import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { createWorklistPool } from '@podium/client-graph/create'
import {
  checkSidebar,
  poolSidebarSnapshot,
  type SidebarDifference,
} from '@podium/client-graph/diagnostics/sidebar-check'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '../../../shared/src/row-source'
import { runInAction } from 'mobx'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { readLive, readSnapshot } from '../fixture/export-snapshot'
import type { FixtureCorpus } from '../fixture/index'
import { corpusFromLive } from '../fixture/live-snapshot'

/** Export order is transport order. Keep this construction testable against
 * the app runtime's replica-seeded store before accepting real-data parity. */
export function sidebarReplayStore(
  corpus: FixtureCorpus,
  replica: Replica,
): Store<PodiumClientApi> {
  // ClientRuntime seeds these lists from ReplicaBinding, not bootstrap order.
  return {
    replica,
    issueProjections: replica.rows('issueProjections'),
    issueUserStates: replica.rows('issueUserStates'),
    issueGitStates: replica.rows('issueGitStates'),
    issueDeps: replica.rows('issueDeps'),
    repoProjections: replica.rows('repos'),
    sessions: dedupeSessions([...replica.rows('sessions')]),
    repos: corpus.repos,
    machines: corpus.machines,
    pins: corpus.pins,
    coarseNow: corpus.fixedNow,
    selectedIssueId: null,
  } as unknown as Store<PodiumClientApi>
}

function replay(corpus: FixtureCorpus) {
  const cache = seedCacheFromCorpus(corpus)
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const store = sidebarReplayStore(corpus, replica)
  const runtime = withKeyedInputs({
    getSnapshot: () => store,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
  })
  const rows = createRowSource(runtime, replica, { mode: 'pooled' })
  const locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source, { summaries: MISSION_SUMMARIES })
  store.sessions = dedupeSessions(
    rows.source.snapshot('session').map((row) => row.value as Store['sessions'][number]),
  )
  try {
    let settled = false
    for (let round = 0; round < 64; round += 1) {
      runInAction(() => poolSidebarSnapshot(handle.pool))
      if (handle.pool.hydrate() === 0) {
        settled = true
        break
      }
    }
    if (!settled) throw new Error('Replay loading did not settle')
    const locations: SidebarDifference[] = []
    const result = runInAction(() =>
      checkSidebar(
        handle.pool,
        store,
        { pinnedRepos: corpus.pins.repos, pinnedWorktrees: corpus.pins.worktrees },
        (difference) => locations.push(difference),
      ),
    )
    // Section/worktree identifiers can be paths. Omit them from the export report.
    const opaqueId = (id: string | null): string | null =>
      id && /^iss_[\w-]+$/.test(id) ? id : null
    const safeLocation = (difference: SidebarDifference) => ({
      sectionIndex: difference.sectionIndex,
      rowIndex: difference.rowIndex,
      field: difference.field,
      expectedId: opaqueId(difference.expectedId),
      actualId: opaqueId(difference.actualId),
    })
    return {
      models: allIssueViewModels(replica),
      sidebar: runInAction(() => poolSidebarSnapshot(handle.pool)),
      report: {
        issues: corpus.issueProjections.length,
        sessions: corpus.sessions.length,
        sections: result.sections,
        rows: result.rows,
        differences: result.differences,
        pending: result.pending,
        first: result.first ? safeLocation(result.first) : null,
        locations: locations.map(safeLocation),
      },
    }
  } finally {
    handle.dispose()
    locals.dispose()
    rows.dispose()
  }
}
async function main(): Promise<void> {
  if (hostname() !== 'ludovico') throw new Error('Operator export replay is restricted to ludovico')
  const path = process.argv[process.argv.indexOf('--snapshot') + 1]
  let corpus: FixtureCorpus
  let inputKinds: Record<string, number> | undefined
  if (process.argv.includes('--live')) {
    const originIndex = process.argv.indexOf('--origin')
    const origin = originIndex < 0 ? 'http://127.0.0.1:18787' : process.argv[originIndex + 1]!
    const { raw, bootstrapEntityCounts } = await readLive(origin)
    inputKinds = bootstrapEntityCounts
    // Current authority rows are replayed verbatim; no compatibility upgrade.
    corpus = {
      ...corpusFromLive(raw, Date.now()),
      issueProjections: raw.issueProjections,
      issueUserStates: raw.issueUserStates ?? [],
      issueGitStates: raw.issueGitStates ?? [],
      repoProjections: raw.repoProjections,
    }
  } else {
    if (!process.argv.includes('--snapshot') || !path)
      throw new Error('Supply --snapshot or --live')
    const snapshot = readSnapshot(path)
    corpus = corpusFromLive(snapshot, Date.parse(snapshot.exportedAt))
  }
  const normalized = replay(corpus)
  console.log(JSON.stringify({ inputKinds, normalizedOnly: normalized.report }))
  if (normalized.report.differences || normalized.report.pending) process.exitCode = 1
}
if (import.meta.main) {
  try {
    await main()
  } catch {
    console.error('Sidebar export replay failed; input/error text withheld')
    process.exitCode = 1
  }
}
