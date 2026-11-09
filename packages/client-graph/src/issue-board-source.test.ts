import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { issueBoardStats } from '../../../tests/worklist/harness/src/perf/issue-board'
import { boardCards } from './issue-board-cards'
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
/** What a mounted desktop card reads (POD-5828): the shared issue and session
 * fields, and the board's own child stage counts. */
function cardOf(pool: MobxPool, id: string) {
  const cards = boardCards(pool),
    issue = cards.issue(id)
  return {
    issue: { id: issue.id, childCount: issue.childCount },
    fleet: issue.presentMembers.map((seat) => seat.id),
    stageCounts: cards.card(issue, false).stageCounts,
    progress: issue.taskProgress,
  }
}
function setup(rows = [row('hot'), row('cold', { archived: true, stage: 'done' })]) {
  const load = vi.fn((_entity: string, id: string) => rows.find((row) => row.id === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    load,
    summaries: ISSUE_BOARD_SUMMARIES,
    schedule: () => () => {},
  })
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
        rows: [
          { kind: 'issue', id, value: { ...rows.find((r) => r.id === id), ...patch } as never },
        ],
      }),
    rebase: (id: string) =>
      pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id, value: rows.find((r) => r.id === id) as never }],
      }),
    stop: () => {
      source.dispose()
      pool.dispose()
    },
  }
}
it('releases board query demand without a resident reverse index', () => {
  const rows = Array.from({ length: 512 }, (_, index) =>
    row(`resident-${index}`, { priority: index === 0 ? 1 : 2 }),
  )
  const { source, pool, paint, stop } = setup(rows)
  let closeBoard = () => {}
  let closeCatalog = () => {}
  try {
    expect(source.stats()).toMatchObject({ residentRows: 0, cached: 0 })
    paint('resident-1', { title: 'Changed while closed' })
    source.issue('resident-0')
    expect(source.stats().residentRows).toBe(0)
    closeBoard = autorun(() => source.queryIds({ kind: 'board', filter: { stage: 'in_progress' } }))
    expect(source.stats().residentRows).toBe(0)
    closeCatalog = autorun(() => source.catalog(false))
    // An imperative snapshot must not release the index of an open surface.
    expect(source.queryIds({ kind: 'board', filter: { priority: 1 } })).toEqual({
      ids: ['resident-0'],
    })
    expect(source.stats().residentRows).toBe(0)
    closeBoard()
    expect(source.stats().residentRows).toBe(0)
    closeCatalog()
    expect(source.stats().residentRows).toBe(0)
    expect(source.stats().demandKeys).toBe(0)
    paint('resident-1', { title: 'Freshly renamed while closed' })
    expect(source.stats().residentRows).toBe(0)
    expect(source.queryIds({ kind: 'board', filter: { text: 'Freshly renamed' } })).toEqual({
      ids: ['resident-1'],
    })
    expect(source.stats().residentRows).toBe(0)
  } finally {
    closeBoard()
    closeCatalog()
    stop()
  }
})

it('retains catalogue metadata across stage, heartbeat and title changes without a resident index', () => {
  const f = setup([row('one', { assignee: 'owner', labels: ['bug'] })])
  let value: ReturnType<typeof f.source.catalog>
  const stop = autorun(() => {
    value = f.source.catalog(false)
  })
  try {
    const before = value!
    expect(before).toEqual({
      scope: ['one'],
      projectPaths: ['/fixture'],
      assignees: ['owner'],
      labels: ['bug'],
    })
    f.paint('one', { stage: 'planning', updatedAt: new Date(now).toISOString(), title: 'Renamed' })
    expect(value!).toBe(before)
    expect(f.source.stats().residentRows).toBe(0)
    f.paint('one', { assignee: 'reviewer', labels: ['feature'] })
    expect(value!).toEqual({
      scope: ['one'],
      projectPaths: ['/fixture'],
      assignees: ['reviewer'],
      labels: ['feature'],
    })
    stop()
    expect(f.source.stats().cached).toBe(0)
  } finally {
    stop()
    f.stop()
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
    expect(board && board !== LOADING && board.rootIds).toEqual(['cold', 'hot'])
    expect(issueBoardStats.read().rowModels ?? 0).toBe(0)
    expect(cardOf(pool, 'cold')).toMatchObject({
      issue: { id: 'cold', childCount: 0 },
      progress: null,
    })
    // The card reads the shared model: one card rule, no row overlay.
    expect(issueBoardStats.read().cards).toBe(1)
    expect(issueBoardStats.read().rowModels ?? 0).toBe(0)
    expect(source.board({ ...options, addressed: ['hot'] })).toEqual(board)
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally {
    issueBoardStats.disable()
    stop()
  }
})
it('derives a virtual card child summary and progress through declared relations', () => {
  const { pool, stop } = setup([
    row('root'),
    row('planning', { parentId: 'root', stage: 'planning' }),
    row('done', { parentId: 'root', stage: 'done' }),
    row('hidden', { parentId: 'root', deletedAt: '2026-01-01T00:00:00Z' }),
  ])
  try {
    expect(cardOf(pool, 'root')).toMatchObject({
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
  const { pool, stop } = setup([row('root')])
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
    const value = cardOf(pool, 'root')
    expect(value.fleet).toEqual(['m', 'z'])
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
  const { source, pool, stop } = setup([
    row('visible', { stage: 'planning' }),
    ...Array.from({ length: 1500 }, (_, n) => row(`hidden-${n}`)),
  ])
  const reads = vi.spyOn(pool, 'row')
  const questions = vi.spyOn(pool.queries, 'ids')
  try {
    expect(source.queryIds({ kind: 'board', filter: { stage: 'planning' } })).toEqual({
      ids: ['visible'],
    })
    expect(questions).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'boardIssues', stage: 'planning' }),
    )
    const issueReads = reads.mock.calls.filter(([entity]) => entity === 'issue').map(([, id]) => id)
    expect(new Set(issueReads)).toEqual(new Set(['visible']))
    expect(issueReads.length).toBeLessThanOrEqual(4)
  } finally {
    reads.mockRestore()
    questions.mockRestore()
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
    expect(source.stats().residentRows).toBe(0)
    expect(source.issue('parent')).toMatchObject({ archived: true })
    pool.apply({
      type: 'replace',
      rows: [{ kind: 'issue', id: 'replacement', value: row('replacement') }],
    })
    expect(ids).toEqual(['replacement'])
    expect(source.stats().residentRows).toBe(0)
  } finally {
    off()
    stop()
  }
})

it('reads the open issue directly from UiStore', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  const ui = { openIssueId: null as import('@podium/model').IssueId | null }
  const source = createIssueBoardSource(pool, { ui })
  try {
    expect(source.read('issueBoardWindow', 'window')).toEqual({ openIssueId: null })
    ui.openIssueId = 'hot' as import('@podium/model').IssueId
    expect(source.read('issueBoardWindow', 'window')).toEqual({ openIssueId: 'hot' })
  } finally {
    source.dispose()
    pool.dispose()
  }
})
it('releases the board owner and refuses reads after disposal', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now })
  const source = createIssueBoardSource(pool, { ui: { openIssueId: null } })
  try {
    expect(source.read('issueBoardWindow', 'current')).toEqual({ openIssueId: null })
    source.dispose()
    source.dispose()
    expect(source.disposed).toBe(true)
    expect(source.read('issueBoardWindow', 'current')).toBe(LOADING)
  } finally {
    source.dispose()
    pool.dispose()
  }
})
