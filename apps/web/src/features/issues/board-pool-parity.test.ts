import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { dedupeSessions, type Store } from '@podium/client-core/engine'
import { sessionViews } from '@podium/client-core/session-values'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { ISSUE_BOARD_ENTITIES, ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_SUMMARIES } from '@podium/client-graph/issue-board-schema'
import { inBoardCheck } from '@podium/client-graph/diagnostics/issue-board-check'
import { expect, it } from 'vitest'
import { buildCorpus, FIXED_NOW } from '../../../../../packages/worklist-proto/harness/src/fixture'
import { seedAcceptanceCache } from '../../../test/sidebar-acceptance-seed'
import { checkBoard, checkExplorer } from './board-pool-check'
import { DEFAULT_DISPLAY } from './issues-display'

it('matches legacy columns, values, nested positions, facets, progress and explorer tabs on the normalized synthetic corpus', async () => {
  const corpus = buildCorpus(1, 4443), cache = seedAcceptanceCache(corpus, 'board-check')
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const sessions = dedupeSessions(sessionViews(replica.rows('sessions'), { userId: 'board-check', userStatesLoaded: true,
    userStates: replica.rows('sessionUserStates'), repos: replica.rows('repos'), machines: replica.rows('machines') }))
  const state = { sessions, repos: corpus.repos, machines: corpus.machines, coarseNow: FIXED_NOW, selectedIssueId: null, openIssueId: null,
    issueProjections: replica.rows('issueProjections'), issueUserStates: replica.rows('issueUserStates'), pins: { repos: [], worktrees: [] }, sidebarSettings: { repoOrder: [] } } as unknown as Store
  const runtime = { replica, getSnapshot: () => state, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map(), ui: { get: () => null, subscribe: () => () => {} } }
  const handle = createRuntimeWorklistPool(runtime as never, { summaries: ISSUE_BOARD_SUMMARIES })
  await handle.pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () => createIssueBoardSource(handle.pool, runtime))
  try {
    for (const filter of [{}, { stage: 'planning' as const }, { status: 'ready' as const }, { archived: true }, { text: 'POD 12' }, { text: 'task' }]) {
      for (const layout of ['board', 'list'] as const) {
        const result = inBoardCheck(() => checkBoard(runtime as never, handle.pool, { display: { ...DEFAULT_DISPLAY, layout }, filter, expanded: [], isMobile: false, openIssueId: null, now: FIXED_NOW }))
        expect(result).toEqual({ differences: 0, first: null, pending: 0 })
      }
    }
    for (const tab of [null, 'needs', 'in_progress', 'planning', 'done', 'cancelled'] as const) {
      expect(inBoardCheck(() => checkExplorer(runtime as never, handle.pool, tab, ''))).toEqual({ differences: 0, first: null, pending: 0 })
    }
    for (const query of ['task', 'POD-12', '']) expect(inBoardCheck(() => checkExplorer(runtime as never, handle.pool, null, query))).toEqual({ differences: 0, first: null, pending: 0 })
    expect(handle.pool.tables.issue.size).toBeLessThan(replica.rows('issueProjections').length)
  } finally { handle.dispose() }
}, 120_000)
