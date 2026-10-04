import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'

import { dedupeSessions } from '@podium/client-graph/diagnostics/reference-state'
import type { ReferenceState } from '@podium/client-graph/diagnostics/reference-state'
type Store = ReferenceState<import('@/app/trpc').Trpc>
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { LOADING } from '@podium/client-graph'
import {
  boardSnapshot,
  explorerSnapshot,
  inBoardCheck,
} from '@podium/client-graph/diagnostics/issue-board-check'
import {
  ISSUE_BOARD_ENTITIES,
  ISSUE_BOARD_SOURCE_KEY,
  ISSUE_BOARD_SUMMARIES,
} from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { expect, it } from 'vitest'
import { buildCorpus, FIXED_NOW } from '../../../../../packages/worklist-proto/harness/src/fixture'
import { expectPoolOutput } from '../../../../../packages/worklist-proto/harness/src/oracle/pool-output'
import { seedAcceptanceCache } from '../../../test/sidebar-acceptance-seed'
import { DEFAULT_DISPLAY } from './issues-display'

function expectBoard(
  pool: import('@podium/client-graph').MobxPool,
  options: import('@podium/client-graph/issue-board-schema').BoardOptions,
) {
  const value = pool.row('issueBoardModel', JSON.stringify(options))
  if (!value || value === LOADING) throw new Error('Board fixture is loading')
  expectPoolOutput(boardSnapshot(value), JSON.stringify(options))
}
function expectExplorer(
  pool: import('@podium/client-graph').MobxPool,
  tab: import('@podium/client-graph/issue-board-schema').PoolExplorerData['tab'] | null,
  query: string,
) {
  const value = pool.row('issueExplorerModel', JSON.stringify({ tab, query }))
  if (!value || value === LOADING) throw new Error('Explorer fixture is loading')
  expectPoolOutput(explorerSnapshot(value), JSON.stringify({ tab, query }))
}

it('matches legacy columns, values, nested positions, facets, progress and explorer tabs on the normalized synthetic corpus', async () => {
  const corpus = buildCorpus(1, 4443),
    cache = seedAcceptanceCache(corpus, 'board-check')
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const sessions = dedupeSessions(
    sessionViews(replica.rows('sessions'), {
      userId: 'board-check',
      userStatesLoaded: true,
      userStates: replica.rows('sessionUserStates'),
      repos: replica.rows('repos'),
      machines: replica.rows('machines'),
    }),
  )
  const state = {
    sessions,
    repos: corpus.repos,
    machines: corpus.machines,
    coarseNow: FIXED_NOW,
    selectedIssueId: null,
    openIssueId: null,
    issueProjections: replica.rows('issueProjections'),
    issueUserStates: replica.rows('issueUserStates'),
    pins: { repos: [], worktrees: [] },
    sidebarSettings: { repoOrder: [] },
  } as unknown as Store
  const runtime = withKeyedInputs({
    replica,
    getSnapshot: () => state,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
    ui: { get: () => null, subscribe: () => () => {} },
  })
  const handle = createRuntimeWorklistPool(runtime as never, { summaries: ISSUE_BOARD_SUMMARIES })
  await handle.pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () =>
    createIssueBoardSource(handle.pool, runtime),
  )
  try {
    for (const filter of [
      {},
      { stage: 'planning' as const },
      { status: 'ready' as const },
      { archived: true },
      { text: 'POD 12' },
      { text: 'task' },
    ]) {
      for (const layout of ['board', 'list'] as const) {
        inBoardCheck(() =>
          expectBoard(handle.pool, {
            display: { ...DEFAULT_DISPLAY, layout },
            filter,
            expanded: [],
            isMobile: false,
            openIssueId: null,
            now: FIXED_NOW,
          }),
        )
      }
    }
    for (const tab of [null, 'needs', 'in_progress', 'planning', 'done', 'cancelled'] as const)
      inBoardCheck(() => expectExplorer(handle.pool, tab, ''))
    for (const query of ['task', 'POD-12', ''])
      inBoardCheck(() => expectExplorer(handle.pool, null, query))
    inBoardCheck(() =>
      expectBoard(handle.pool, {
        display: { ...DEFAULT_DISPLAY, layout: 'list', ordering: 'updated', showAgentTasks: true },
        filter: {},
        expanded: replica.rows('issueProjections').map((row) => row.id),
        isMobile: false,
        openIssueId: null,
        now: FIXED_NOW,
      }),
    )
    expect(handle.pool.tables.issue.size).toBeLessThan(replica.rows('issueProjections').length)
  } finally {
    handle.dispose()
  }
}, 120_000)
