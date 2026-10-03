import { dedupeSessions, type Store } from '@podium/client-core/engine'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { boardSnapshot, explorerSnapshot, inBoardCheck } from '@podium/client-graph/diagnostics/issue-board-check'
import {
  ISSUE_BOARD_ENTITIES,
  ISSUE_BOARD_SOURCE_KEY,
  ISSUE_BOARD_SUMMARIES,
} from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { expect, it } from 'vitest'
import { buildCorpus, FIXED_NOW } from '../../../../../packages/worklist-proto/harness/src/fixture'
import { seedAcceptanceCache } from '../../../test/sidebar-acceptance-seed'
import { checkBoard as legacyBoardCheck, checkExplorer as legacyExplorerCheck } from './board-pool-check'
import { expectPoolOutput } from '../../../../../packages/worklist-proto/harness/src/oracle/pool-output'
import { LOADING } from '@podium/client-graph'
import { DEFAULT_DISPLAY } from './issues-display'

function checkBoard(...args: Parameters<typeof legacyBoardCheck>) {
  const result = legacyBoardCheck(...args)
  expect(result).toEqual({ differences: 0, first: null, pending: 0 })
  const value = args[1].row('issueBoardModel', JSON.stringify(args[2]))
  if (!value || value === LOADING) throw new Error('Board fixture is loading')
  expectPoolOutput(boardSnapshot(value), JSON.stringify(args[2]))
  return result
}
function checkExplorer(...args: Parameters<typeof legacyExplorerCheck>) {
  const result = legacyExplorerCheck(...args)
  expect(result).toEqual({ differences: 0, first: null, pending: 0 })
  const value = args[1].row('issueExplorerModel', JSON.stringify({ tab: args[2], query: args[3] }))
  if (!value || value === LOADING) throw new Error('Explorer fixture is loading')
  expectPoolOutput(explorerSnapshot(value), JSON.stringify({ tab: args[2], query: args[3] }))
  return result
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
  const runtime = {
    replica,
    getSnapshot: () => state,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
    ui: { get: () => null, subscribe: () => () => {} },
  }
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
        const result = inBoardCheck(() =>
          checkBoard(runtime as never, handle.pool, {
            display: { ...DEFAULT_DISPLAY, layout },
            filter,
            expanded: [],
            isMobile: false,
            openIssueId: null,
            now: FIXED_NOW,
          }),
        )
        expect(result).toEqual({ differences: 0, first: null, pending: 0 })
      }
    }
    for (const tab of [null, 'needs', 'in_progress', 'planning', 'done', 'cancelled'] as const) {
      expect(inBoardCheck(() => checkExplorer(runtime as never, handle.pool, tab, ''))).toEqual({
        differences: 0,
        first: null,
        pending: 0,
      })
    }
    for (const query of ['task', 'POD-12', ''])
      expect(inBoardCheck(() => checkExplorer(runtime as never, handle.pool, null, query))).toEqual(
        { differences: 0, first: null, pending: 0 },
      )
    expect(
      inBoardCheck(() =>
        checkBoard(runtime as never, handle.pool, {
          display: {
            ...DEFAULT_DISPLAY,
            layout: 'list',
            ordering: 'updated',
            showAgentTasks: true,
          },
          filter: {},
          expanded: replica.rows('issueProjections').map((row) => row.id),
          isMobile: false,
          openIssueId: null,
          now: FIXED_NOW,
        }),
      ),
    ).toEqual({ differences: 0, first: null, pending: 0 })
    expect(handle.pool.tables.issue.size).toBeLessThan(replica.rows('issueProjections').length)
  } finally {
    handle.dispose()
  }
}, 120_000)
