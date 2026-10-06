import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'

import { dedupeSessions } from '../../../../../tests/worklist/diagnostics/reference-state'
import type { ReferenceState } from '../../../../../tests/worklist/diagnostics/reference-state'
type Store = ReferenceState<import('@/app/trpc').Trpc>
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { LOADING } from '@podium/client-graph'
import {
  readBoardSnapshot,
  explorerSnapshot,
  inBoardCheck,
} from '../../../../../tests/worklist/diagnostics/issue-board-check'
import {
  ISSUE_BOARD_ENTITIES,
  ISSUE_BOARD_SOURCE_KEY,
  ISSUE_BOARD_SUMMARIES,
} from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { createReadOnlyRuntimePool } from '../../../../../tests/worklist/shared/src/read-only-pool'
import { expect, it } from 'vitest'
import { buildCorpus, FIXED_NOW } from '../../../../../tests/worklist/harness/src/fixture'
import { expectPoolOutput } from '../../../../../tests/worklist/harness/src/oracle/pool-output'
import { seedAcceptanceCache } from '../../../test/sidebar-acceptance-seed'
import { DEFAULT_DISPLAY } from './issues-display'

function expectBoard(
  pool: import('@podium/client-graph').MobxPool,
  options: import('@podium/client-graph/issue-board-schema').BoardOptions,
) {
  const { value, unread } = inBoardCheck(() => {
    const value = readBoardSnapshot(pool, options)
    if (value === LOADING) return { value, unread: [] }
    return { value, unread: value.values.flatMap(({ fields }) => {
      const id = fields.id as string
      const card = pool.row('issueBoardCard', JSON.stringify({ id, agents: options.display.showAgentTasks }))
      return card && card !== LOADING && card.issue.unread !== fields.unread
        ? [{ id, expected: fields.unread, actual: card.issue.unread }] : []
    }) }
  })
  if (!value || value === LOADING) throw new Error('Board fixture is loading')
  expect(unread).toEqual([])
  expectPoolOutput(value, JSON.stringify(options))
}
function expectExplorer(
  pool: import('@podium/client-graph').MobxPool,
  tab: import('@podium/client-graph/issue-board-schema').PoolExplorerData['tab'] | null,
  query: string,
) {
  const value = inBoardCheck(() => pool.row('issueExplorerModel', JSON.stringify({ tab, query })))
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
    principal: { userId: 'board-check' },
    replica,
    getSnapshot: () => state,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
    ui: { get: () => null, subscribe: () => () => {} },
  })
  // This frozen-value fixture only reads server truth; it owns no mutations.
  const handle = createReadOnlyRuntimePool(runtime as never, ISSUE_BOARD_SUMMARIES)
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
        expectBoard(handle.pool, {
          display: { ...DEFAULT_DISPLAY, layout },
          filter,
          expanded: [],
          isMobile: false,
          openIssueId: null,
          now: FIXED_NOW,
        })
      }
    }
    for (const tab of [null, 'needs', 'in_progress', 'planning', 'done', 'cancelled'] as const)
      expectExplorer(handle.pool, tab, '')
    for (const query of ['task', 'POD-12', ''])
      expectExplorer(handle.pool, null, query)
    expectBoard(handle.pool, {
      display: { ...DEFAULT_DISPLAY, layout: 'list', ordering: 'updated', showAgentTasks: true },
      filter: {},
      expanded: replica.rows('issueProjections').map((row) => row.id),
      isMobile: false,
      openIssueId: null,
      now: FIXED_NOW,
    })
    expect(handle.pool.tables.issue.size).toBeLessThan(replica.rows('issueProjections').length)
  } finally {
    handle.dispose()
  }
}, 120_000)
