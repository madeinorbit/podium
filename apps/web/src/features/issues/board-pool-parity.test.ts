import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import type { ReferenceState } from '../../../../../tests/worklist/diagnostics/reference-state'
import { dedupeSessions } from '../../../../../tests/worklist/diagnostics/reference-state'

type Store = ReferenceState<import('@/app/trpc').Trpc>

import type { IssueViewModel } from '@podium/client-core/replica'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph'
import { boardCards } from '@podium/client-graph/issue-board-cards'
import type { BoardOptions } from '@podium/client-graph/issue-board-schema'
import {
  ISSUE_BOARD_ENTITIES,
  ISSUE_BOARD_SOURCE_KEY,
} from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { ISSUE_BOARD_STAGES, ISSUE_STAGES, isFinished } from '@podium/model/browser'
import { expect, it } from 'vitest'
import {
  inBoardCheck,
  readBoardSnapshot,
} from '../../../../../tests/worklist/diagnostics/issue-board-check'
import { issueViewModelsFromReplica } from '../../../../../tests/worklist/diagnostics/reference/issue-view-models'
import { buildCorpus, FIXED_NOW } from '../../../../../tests/worklist/harness/src/fixture'
import { createReadOnlyRuntimePool } from '../../../../../tests/worklist/shared/src/read-only-pool'
import { seedAcceptanceCache } from '../../../test/sidebar-acceptance-seed'
import { DEFAULT_DISPLAY } from './issues-display'

type Truth = {
  stored: ReadonlyMap<string, object>
  rows: ReadonlyMap<string, IssueViewModel>
}

// Expected values come from server projections and the independent stateless
// fixture composer. No pool layout, model or index answers these questions.
function inScope(row: IssueViewModel, truth: Truth, agents: boolean, liveParents = false): boolean {
  if (row.isDraftVessel && !row.deletedAt) return false
  if (agents || row.deletedAt || row.audience !== 'agent') return true
  const visited = new Set([row.id])
  let parent = row.parentId
  while (parent && !visited.has(parent)) {
    visited.add(parent)
    const ancestor = truth.rows.get(parent)
    if (
      !ancestor ||
      (ancestor.isDraftVessel && !ancestor.deletedAt) ||
      (liveParents && (ancestor.archived || ancestor.deletedAt))
    )
      return false
    if (ancestor.deletedAt || ancestor.audience !== 'agent') return true
    parent = ancestor.parentId
  }
  return false
}

function expectedMembers(truth: Truth, options: BoardOptions): IssueViewModel[] {
  const { filter, display } = options
  const text = filter.text?.trim().toLowerCase()
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  return [...truth.rows.values()].filter((row) => {
    if ((row.deletedAt && !filter.deleted) || (row.archived && !filter.archived)) return false
    if (!inScope(row, truth, display.showAgentTasks)) return false
    if (filter.stage && row.stage !== filter.stage) return false
    if (filter.status === 'ready' && !row.ready) return false
    if (
      text &&
      !row.title.toLowerCase().includes(text) &&
      !(/\d/.test(text) && normalized(row.displayRef).includes(normalized(text)))
    )
      return false
    return true
  })
}

const storedFields = [
  'id',
  'seq',
  'title',
  'stage',
  'closedReason',
  'priority',
  'type',
  'assignee',
  'labels',
  'createdAt',
  'updatedAt',
  'archived',
  'deletedAt',
  'parentId',
  'worktreePath',
  'branch',
  'estimateMin',
  'dueAt',
  'deferUntil',
  'defaultAgent',
] as const

function expectBoard(pool: MobxPool, options: BoardOptions, truth: Truth) {
  const { value, unread } = inBoardCheck(() => {
    const value = readBoardSnapshot(pool, options)
    if (value === LOADING) return { value, unread: [] }
    return {
      value,
      unread: value.values.flatMap(({ fields }) => {
        const id = fields.id as string
        const card = boardCards(pool).issue(id)
        return card.unread !== fields.unread
          ? [{ id, expected: fields.unread, actual: card.unread }]
          : []
      }),
    }
  })
  if (!value || value === LOADING) throw new Error('Board fixture is loading')
  expect(unread).toEqual([])
  const active = expectedMembers(truth, options)
  expect(active.length).toBeGreaterThan(0)
  const byId = new Map(active.map((row) => [row.id, row]))
  const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id).sort()
  const missing = active
    .filter((row) => !value.active.includes(row.id))
    .map((row) => ({
      id: row.id,
      parent: row.parentId,
      stage: row.stage,
      audience: row.audience,
      draft: row.isDraftVessel,
      scope: pool.queries.issueScope(row.id),
      parentScope: row.parentId ? pool.queries.issueScope(row.parentId) : undefined,
    }))
  expect([...value.active].sort(), JSON.stringify({ options, missing })).toEqual(ids(active))
  const roots = active.filter(
    (row) => !row.parentId || row.parentId === row.id || !byId.has(row.parentId),
  )
  const children = (id: string) => active.filter((row) => row.parentId === id && row.id !== id)
  expect(value.layout).toBe(options.display.layout)
  expect(value.columns.map((column) => column.stage)).toEqual([...ISSUE_BOARD_STAGES])
  for (const column of value.columns) {
    const expectedRoots = roots.filter((row) => row.stage === column.stage)
    const missingRoots = expectedRoots
      .filter((row) => !column.ids.includes(row.id))
      .map((row) => ({
        id: row.id,
        parent: row.parentId,
        graphParent: pool.graph.one('issue', row.id, 'treeParent'),
        stage: row.stage,
        audience: row.audience,
      }))
    expect(
      [...column.ids].sort(),
      JSON.stringify({ options, column: column.stage, missingRoots }),
    ).toEqual(ids(expectedRoots))
    for (let at = 1; at < column.ids.length; at++) {
      const previous = byId.get(column.ids[at - 1]!)!,
        next = byId.get(column.ids[at]!)!
      if (options.display.ordering === 'priority')
        expect(previous.priority - next.priority || previous.seq - next.seq).toBeLessThanOrEqual(0)
      else {
        const field = options.display.ordering === 'updated' ? 'updatedAt' : 'createdAt'
        expect(previous[field].localeCompare(next[field])).toBeGreaterThanOrEqual(0)
      }
    }
  }
  if (options.display.layout === 'board') expect(value.rows).toEqual([])
  else {
    const shown = value.rows.flatMap((group) => group.rows)
    expect(value.listIds).toEqual(shown.map((row) => row.id))
    const expectedShown = options.expanded.length ? active : roots
    expect(
      [...value.listIds].sort(),
      JSON.stringify({
        options,
        listMissing: expectedShown
          .filter((row) => !value.listIds.includes(row.id))
          .map((row) => ({
            id: row.id,
            parent: row.parentId,
            stage: row.stage,
            graphParent: pool.graph.one('issue', row.id, 'treeParent'),
          })),
      }),
    ).toEqual(ids(expectedShown))
    const positions = new Map(shown.map((row, at) => [row.id, at]))
    for (const group of value.rows)
      for (const row of group.rows) {
        const expected = byId.get(row.id)!
        let root = expected,
          depth = 0
        const visited = new Set([row.id])
        while (root.parentId && byId.has(root.parentId) && !visited.has(root.parentId)) {
          root = byId.get(root.parentId)!
          visited.add(root.id)
          depth++
        }
        expect(row.depth).toBe(depth)
        expect(group.stage).toBe(root.stage)
        expect(row.childCount).toBe(children(row.id).length)
        expect(row.expanded).toBe(children(row.id).length > 0 && options.expanded.includes(row.id))
        if (depth) expect(positions.get(expected.parentId!)!).toBeLessThan(positions.get(row.id)!)
      }
  }
  for (const { fields, counts, progress } of value.values) {
    const id = fields.id as string,
      stored = truth.stored.get(id)!,
      expected = truth.rows.get(id)!
    for (const field of storedFields)
      if (Object.hasOwn(stored, field))
        expect(fields[field], `${id}.${field}`).toEqual(Reflect.get(stored, field))
    expect(fields.displayRef, `${id}.displayRef`).toBe(expected.displayRef)
    expect(fields.repoPath, `${id}.repoPath`).toBe(expected.repoPath)
    const liveChildren =
      !expected.archived &&
      !expected.deletedAt &&
      inScope(expected, truth, options.display.showAgentTasks, true)
        ? [...truth.rows.values()].filter(
            (row) =>
              row.parentId === id &&
              row.id !== id &&
              !row.archived &&
              !row.deletedAt &&
              inScope(row, truth, options.display.showAgentTasks, true),
          )
        : []
    expect(counts, `${id}.childStages`).toEqual(
      ISSUE_STAGES.flatMap((stage) => {
        const count = liveChildren.filter((row) => row.stage === stage).length
        return count ? [{ stage, count }] : []
      }),
    )
    if (roots.some((row) => row.id === id)) {
      const descendants: IssueViewModel[] = [],
        seen = new Set([id])
      const pending = [...truth.rows.values()].filter((row) => row.parentId === id)
      while (pending.length) {
        const row = pending.pop()!
        if (seen.has(row.id)) continue
        seen.add(row.id)
        if (row.archived || row.deletedAt || row.isDraftVessel) continue
        descendants.push(row)
        pending.push(...[...truth.rows.values()].filter((child) => child.parentId === row.id))
      }
      if (descendants.length)
        expect(progress, `${id}.progress`).toMatchObject({
          total: descendants.length,
          done: descendants.filter(isFinished).length,
        })
      else expect(progress, `${id}.progress`).toBeNull()
    }
  }
}
it('covers board model fields, filters, columns, nested positions and progress from server truth', async () => {
  const corpus = buildCorpus(1, 4443),
    cache = seedAcceptanceCache(corpus, 'board-check')
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const projections = replica.rows('issueProjections')
  const composed = issueViewModelsFromReplica(replica)
  const truth: Truth = {
    stored: new Map(projections.map((row) => [row.id, row])),
    rows: new Map(
      [...composed].map(([id, row]) => {
        const deferred =
          Number.isFinite(Date.parse(row.deferUntil ?? '')) &&
          Date.parse(row.deferUntil!) > FIXED_NOW
        return [
          id,
          {
            ...row,
            deferred,
            ready: !row.blocked && !deferred && !isFinished(row),
          } as IssueViewModel,
        ]
      }),
    ),
  }
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
  const handle = createReadOnlyRuntimePool(runtime as never)
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
        expectBoard(
          handle.pool,
          {
            display: { ...DEFAULT_DISPLAY, layout },
            filter,
            expanded: [],
            isMobile: false,
            openIssueId: null,
            now: FIXED_NOW,
          },
          truth,
        )
      }
    }
    expectBoard(
      handle.pool,
      {
        display: { ...DEFAULT_DISPLAY, layout: 'list', ordering: 'updated', showAgentTasks: true },
        filter: {},
        expanded: replica.rows('issueProjections').map((row) => row.id),
        isMobile: false,
        openIssueId: null,
        now: FIXED_NOW,
      },
      truth,
    )
    expect(handle.pool.tables.issue.size).toBeLessThan(replica.rows('issueProjections').length)
  } finally {
    handle.dispose()
  }
}, 120_000)
