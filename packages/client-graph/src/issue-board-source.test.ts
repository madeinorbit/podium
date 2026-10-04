import { issueBoardStats } from '@podium/client-core/perf'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { ISSUE_BOARD_SUMMARIES } from './issue-board-schema'
import { createIssueBoardSource } from './issue-board-source'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z')
const row = (id: string, overrides: object = {}) => ({
  id,
  seq: 1,
  title: id,
  description: { value: 'Searchable body' },
  stage: 'in_progress',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  priority: 2,
  type: 'task',
  labels: [],
  audience: 'human' as const,
  repoPath: '/fixture',
  deps: [],
  ...overrides,
})
function setup(rows = [row('hot'), row('cold', { archived: true, stage: 'done' })]) {
  const load = vi.fn((_entity: string, id: string) => rows.find((row) => row.id === id))
  const pool = new MobxPool(
    { selectedIssueId: null, coarseNow: now },
    undefined,
    { load, summaries: ISSUE_BOARD_SUMMARIES, schedule: () => () => {} },
  )
  pool.apply({
    type: 'replace',
    rows: rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
  })
  const source = createIssueBoardSource(pool)
  return {
    pool,
    source,
    load,
    // POD-5432: a pending change arrives as the row the transaction log
    // painted, and its rollback as the server row.
    paint: (id: string, patch: object) =>
      pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id, value: { ...rows.find((r) => r.id === id), ...patch } as never }],
      }),
    rebase: (id: string) =>
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id, value: rows.find((r) => r.id === id) as never }] }),
    stop: () => {
      source.dispose()
      pool.dispose()
    },
  }
}
it('indexes residents only while a board or catalogue reader observes them', () => {
  const rows = Array.from({ length: 512 }, (_, index) => row(`resident-${index}`, { priority: index === 0 ? 1 : 2 }))
  const { source, pool, paint, stop } = setup(rows)
  let closeBoard = () => {}
  let closeCatalog = () => {}
  try {
    expect(source.stats()).toMatchObject({ residentRows: 0, cached: 0 })
    paint('resident-1', { title: 'Changed while closed' })
    source.issue('resident-0')
    expect(source.stats().residentRows).toBe(0)
    closeBoard = autorun(() => source.queryIds({ kind: 'board', filter: { priority: 1 } }))
    expect(source.stats().residentRows).toBe(pool.tables.issue.size)
    closeCatalog = autorun(() => source.catalog(false))
    // An imperative snapshot must not release the index of an open surface.
    expect(source.queryIds({ kind: 'board', filter: { priority: 1 } })).toEqual({ ids: ['resident-0'] })
    expect(source.stats().residentRows).toBe(512)
    closeBoard()
    expect(source.stats().residentRows).toBe(512)
    closeCatalog()
    expect(source.stats().residentRows).toBe(0)
    expect(source.stats().demandKeys).toBe(0)
    paint('resident-1', { title: 'Freshly renamed while closed' })
    expect(source.stats().residentRows).toBe(0)
    expect(source.queryIds({ kind: 'board', filter: { text: 'Freshly renamed' } })).toEqual({ ids: ['resident-1'] })
    expect(source.stats().residentRows).toBe(0)
  } finally {
    closeBoard()
    closeCatalog()
    stop()
  }
})

it('releases demanded ID results on filter change and unmount', () => {
  const { source, stop } = setup()
  const query = observable.box('in_progress')
  const unmount = autorun(() =>
    source.queryIds({ kind: 'board', filter: { stage: query.get() as 'in_progress' } }),
  )
  try {
    expect(source.stats().demandKeys).toBe(1)
    runInAction(() => query.set('planning'))
    expect(source.stats().demandKeys).toBe(1)
    unmount()
    expect(source.stats().demandKeys).toBe(0)
  } finally {
    unmount()
    stop()
  }
})
it('uses declared cold summaries without promoting cards or hydrating the world', () => {
  const { source, pool, load, stop } = setup([
    row('hot'),
    row('cold', { archived: true, stage: 'done', defaultAgent: 'codex' }),
  ])
  try {
    expect(source.queryIds({ kind: 'board', filter: { archived: true } })).toEqual({
      ids: ['cold', 'hot'],
    })
    expect(source.issue('cold')).toMatchObject({
      id: 'cold',
      description: 'Searchable body',
      stage: 'done',
      defaultAgent: 'codex',
    })
    expect(pool.tables.issue.has('cold')).toBe(false)
    expect(source.stats().residentRows).toBe(0)
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally {
    stop()
  }
})
it('keeps rich card derivations inside the virtual window and addresses selection separately', () => {
  const { source, pool, load, stop } = setup()
  const options = {
    display: { layout: 'board', ordering: 'priority', showAgentTasks: false },
    filter: { archived: true },
    expanded: [],
    isMobile: false,
    openIssueId: null,
    now,
    windowed: true,
  } as const
  issueBoardStats.enable()
  issueBoardStats.reset()
  try {
    const board = source.board(options)
    expect(board && board !== LOADING && board.view.boardIssues.map((row) => row.id)).toEqual([
      'cold',
      'hot',
    ])
    expect(issueBoardStats.read().rowModels ?? 0).toBe(0)
    expect(source.card({ id: 'cold', now })).toMatchObject({
      issue: { id: 'cold', childCount: 0 },
      sessions: [],
      progress: null,
    })
    expect(issueBoardStats.read().rowModels).toBe(1)
    expect(source.board({ ...options, addressed: ['hot'] })).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ id: 'hot', childCount: 0 })]),
    })
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally {
    issueBoardStats.disable()
    stop()
  }
})
it('derives a virtual card child summary and progress through declared relations', () => {
  const { source, stop } = setup([
    row('root'),
    row('planning', { parentId: 'root', stage: 'planning' }),
    row('done', { parentId: 'root', stage: 'done' }),
    row('hidden', { parentId: 'root', deletedAt: '2026-01-01T00:00:00Z' }),
  ])
  try {
    expect(source.card({ id: 'root', now })).toMatchObject({
      issue: { childCount: 3 },
      stageCounts: [
        { stage: 'planning', count: 1 },
        { stage: 'done', count: 1 },
      ],
      progress: { total: 2, done: 1, liveAgents: 0 },
    })
  } finally {
    stop()
  }
})
it('orders a virtual fleet by declared member IDs after resume collapse', () => {
  const { source, pool, stop } = setup([row('root')])
  const seat = (id: string, status: string, resume?: { kind: string; value: string }) => ({
    sessionId: id,
    cwd: '/fixture',
    issueId: 'root',
    agentKind: 'codex',
    status,
    resume,
    headless: false,
    archived: false,
    agentState: { phase: status === 'live' ? 'working' : 'ended' },
    lastActiveAt: '2026-01-01T00:00:00Z',
  })
  pool.apply({
    type: 'update',
    rows: [
      seat('a', 'exited', { kind: 'codex', value: 'same' }),
      seat('m', 'live'),
      {
        ...seat('z', 'exited', { kind: 'codex', value: 'same' }),
        lastActiveAt: '2026-02-01T00:00:00Z',
      },
    ].map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
  })
  try {
    const value = source.card({ id: 'root', now })
    expect(value && value !== LOADING && value.sessions.map((seat) => seat.sessionId)).toEqual([
      'z',
      'm',
    ])
    expect(value && value !== LOADING && value.fleet.map((seat) => seat.sessionId)).toEqual([
      'm',
      'z',
    ])
  } finally {
    stop()
  }
})
it('answers a missing summary with LOADING and one batched load', () => {
  const { source, pool, load, stop } = setup()
  try {
    vi.spyOn(pool.residency!, 'summary').mockReturnValue(undefined)
    expect(source.issue('cold')).toBe(LOADING)
    expect(source.issue('cold')).toBe(LOADING)
    expect(load).not.toHaveBeenCalled()
    expect(pool.hydrate()).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)
  } finally {
    stop()
  }
})
it('stage changes examine the matching resident bucket, independent of hidden residents', () => {
  const { source, stop } = setup([
    row('visible', { stage: 'planning' }),
    ...Array.from({ length: 1500 }, (_, n) => row(`hidden-${n}`)),
  ])
  issueBoardStats.enable()
  issueBoardStats.reset()
  try {
    expect(source.queryIds({ kind: 'board', filter: { stage: 'planning' } })).toEqual({
      ids: ['visible'],
    })
    expect(issueBoardStats.read().residentCandidates).toBe(1)
    expect(issueBoardStats.read().coldSummaryVisits).toBe(0)
  } finally {
    issueBoardStats.disable()
    stop()
  }
})
it('keeps an empty review with a discovered continuation out of Needs you', () => {
  const { source, stop } = setup([
    row('origin', { stage: 'review' }),
    row('tip', { deps: [{ id: 'origin', type: 'discovered-from' }] }),
  ])
  try {
    expect(source.queryIds({ kind: 'explorer', tab: 'needs' })).toEqual({ ids: [] })
  } finally {
    stop()
  }
})
it('preserves an opaque parent reference without loading an absent parent', () => {
  const { source, pool, load, stop } = setup([row('child', { parentId: 'absent-parent' })])
  try {
    expect(source.issue('child')).toMatchObject({ parentId: 'absent-parent' })
    expect(source.queryIds({ kind: 'board' })).toEqual({ ids: ['child'] })
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally {
    stop()
  }
})
it('updates painted changes, parent scope, archive and replacement without a cold standing index', () => {
  const { source, pool, paint, rebase, stop } = setup([
    row('parent'),
    row('child', { audience: 'agent', parentId: 'parent' }),
    row('draft', { isDraftVessel: true }),
  ])
  let ids: string[] = []
  const off = autorun(() => {
    const value = source.queryIds({ kind: 'board' })
    if (value && value !== LOADING) ids = value.ids
  })
  try {
    expect(ids).toEqual(['child', 'parent'])
    paint('parent', { audience: 'agent' })
    expect(ids).toEqual([])
    rebase('parent')
    expect(ids).toEqual(['child', 'parent'])
    pool.apply({
      type: 'update',
      rows: [
        { kind: 'issue', id: 'parent', value: row('parent', { stage: 'done', archived: true }) },
      ],
    })
    // The pool retains an already resident ancestor; the board does not own
    // cutoff policy. Its index must mirror exactly the resident population.
    expect(source.stats().residentRows).toBe(pool.tables.issue.size)
    expect(source.issue('parent')).toMatchObject({ archived: true })
    pool.apply({
      type: 'replace',
      rows: [{ kind: 'issue', id: 'replacement', value: row('replacement') }],
    })
    expect(ids).toEqual(['replacement'])
    expect(source.stats().residentRows).toBe(1)
  } finally {
    off()
    stop()
  }
})

it('follows the open issue through the keyed locals (POD-5433)', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  let openIssueId: string | null = null
  const listeners = new Set<() => void>()
  const source = createIssueBoardSource(pool, {
    readLocal: () => openIssueId,
    onLocals: (keys, listener) => {
      expect(keys).toEqual(['openIssueId'])
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  try {
    expect(source.read('issueBoardWindow', 'window')).toEqual({ openIssueId: null })
    openIssueId = 'hot'
    for (const listener of listeners) listener()
    expect(source.read('issueBoardWindow', 'window')).toEqual({ openIssueId: 'hot' })
  } finally {
    source.dispose()
    pool.dispose()
  }
})
