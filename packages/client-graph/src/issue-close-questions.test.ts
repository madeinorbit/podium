import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { issuePages } from './issue-page'
import { ISSUE_PAGE_SUMMARIES } from './issue-page-schema'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'
import { LOADING } from './worklist/rollup'

const old = '2020-01-01T00:00:00Z'
const issue = (id: string, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
  id, seq: 1, title: id, description: '', stage: 'planning', parentBranch: 'main',
  repoPath: '/fixture', audience: 'human', labels: [], deps: [], priority: 2,
  createdAt: old, updatedAt: old, ...patch,
} } as RowRecord)
const session = (id: string, patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
  sessionId: id, issueId: 'target', title: id, agentKind: 'codex', status: 'live',
  cwd: '/fixture', createdAt: old, lastActiveAt: old, archived: false,
  agentState: { phase: 'working', since: old }, ...patch,
} } as RowRecord)
function fixture(rows: RowRecord[]) {
  const values = new Map(rows.map(row => [`${row.kind}:${row.id}`, row.value]))
  let source = createColdIndex(SCHEMA, ISSUE_PAGE_SUMMARIES)
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }, undefined, {
    cold: () => source, load: (kind, id) => values.get(`${kind}:${id}`),
    summaries: ISSUE_PAGE_SUMMARIES, worklist: 'demand', schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  return {
    pool,
    publish(event: RowSourceEvent) {
      for (const row of event.rows) {
        if (row.value) values.set(`${row.kind}:${row.id}`, row.value)
        else values.delete(`${row.kind}:${row.id}`)
      }
      source.apply(event); pool.apply(event)
    },
    fresh(rows: RowRecord[]) {
      source = createColdIndex(SCHEMA, ISSUE_PAGE_SUMMARIES)
      source.apply({ type: 'replace', rows })
      pool.apply({ type: 'replace', rows })
    },
  }
}

it('maintains canonical web session concerns without counting archives, shells or collapsed twins', () => {
  const f = fixture([issue('target'),
    session('working'), session('headless', { headless: true }),
    session('offer', { offer: { message: 'Choose', actions: [], createdAt: old } }),
    session('archive', { archived: true }), session('shell', { agentKind: 'shell', busy: true }),
    session('stopped', { status: 'exited' }),
    session('a-twin', { status: 'exited', resume: { kind: 'codex-thread', value: 'twins' } }),
    session('z-twin', { status: 'hibernated', lastActiveAt: '2020-01-02', resume: { kind: 'codex-thread', value: 'twins' } }),
  ])
  try {
    const expected = issuePages(f.pool).memberSessions('target')
    expect(expected).not.toBe(LOADING)
    // Only live working + headless are green; offers and parked phases are not.
    expect(f.pool.queries.issueCloseCounts('target')).toEqual({ offers: 1, working: 2 })
    f.publish({ type: 'update', rows: [session('a-twin', { status: 'live', resume: { kind: 'codex-thread', value: 'twins' } })] })
    expect(f.pool.queries.issueCloseCounts('target')).toEqual({ offers: 1, working: 3 })
  } finally { f.pool.dispose() }
})

it('publishes only affected owners across moves, optimism, rollback, deletion and replacement', () => {
  const f = fixture([issue('target'), issue('other'), session('seat')])
  let runs = 0, seen: unknown
  const stop = autorun(() => { runs++; seen = f.pool.queries.issueCloseCounts('target') })
  try {
    expect(seen).toEqual({ offers: 0, working: 1 })
    f.publish({ type: 'update', rows: [session('seat', { title: 'Renamed' })] })
    expect(runs).toBe(1)
    f.publish({ type: 'update', rows: [session('foreign', { issueId: 'other' })] })
    expect(runs).toBe(1)
    runInAction(() => f.pool.tables.session.set('seat', session('seat', { issueId: 'other' }).value as never))
    expect(seen).toEqual({ offers: 0, working: 0 })
    runInAction(() => f.pool.tables.session.delete('seat'))
    expect(seen).toEqual({ offers: 0, working: 1 })
    f.publish({ type: 'update', rows: [session('seat', { issueId: 'other' })] })
    expect(seen).toEqual({ offers: 0, working: 0 })
    f.publish({ type: 'update', rows: [{ kind: 'session', id: 'seat', value: undefined }] })
    expect(seen).toEqual({ offers: 0, working: 0 })
    f.fresh([issue('target'), session('fresh', { headless: true })])
    expect(seen).toEqual({ offers: 0, working: 1 })
  } finally { stop(); f.pool.dispose() }
})

it('counts raw direct children and only stage=done across parent moves and local edits', () => {
  const f = fixture([issue('target'), issue('other'),
    issue('open', { parentId: 'target' }),
    issue('done', { parentId: 'target', stage: 'done', archived: true }),
    issue('deleted', { parentId: 'target', deletedAt: old, closedReason: 'cancelled' }),
  ])
  let seen: unknown, runs = 0
  const stop = autorun(() => { runs++; seen = f.pool.queries.issueChildCounts('target') })
  try {
    expect(seen).toEqual({ childCount: 3, childDoneCount: 1 })
    f.publish({ type: 'update', rows: [issue('open', { parentId: 'target', title: 'Renamed' })] })
    expect(runs).toBe(1)
    runInAction(() => f.pool.tables.issue.set('open', issue('open', { parentId: 'other', stage: 'done' }).value as never))
    expect(seen).toEqual({ childCount: 2, childDoneCount: 1 })
    runInAction(() => f.pool.tables.issue.delete('open'))
    expect(seen).toEqual({ childCount: 3, childDoneCount: 1 })
    f.publish({ type: 'update', rows: [issue('open', { parentId: 'target', stage: 'done' })] })
    expect(seen).toEqual({ childCount: 3, childDoneCount: 2 })
    f.publish({ type: 'update', rows: [{ kind: 'issue', id: 'open', value: undefined }] })
    expect(seen).toEqual({ childCount: 2, childDoneCount: 1 })
    f.fresh([issue('target')])
    expect(seen).toEqual({ childCount: 0, childDoneCount: 0 })
  } finally { stop(); f.pool.dispose() }
})

it('keeps first/repeated close reads and unrelated updates flat as target history grows 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const rows = [issue('target'), issue('other'), session('current'),
      ...Array.from({ length: 128 * scale }, (_, n) => session(`history-${n}`, { archived: true, status: 'exited' })),
      ...Array.from({ length: 128 * scale }, (_, n) => issue(`child-${n}`, { parentId: 'target', stage: 'done', archived: true })),
      ...Array.from({ length: 128 * scale }, (_, n) => session(`foreign-${n}`, { issueId: 'other', archived: true })),
    ]
    const f = fixture(rows), ids = vi.spyOn(f.pool.queries, 'ids')
    let close: unknown, runs = 0
    try {
      const reads = await measureWork(async () => insideReader('close action', () => {
        for (let n = 0; n < 3; n++) close = issuePages(f.pool).closeFacts('target')
      }), { pool: f.pool })
      expect(close).toMatchObject({ subject: { childCount: 128 * scale, childDoneCount: 128 * scale }, members: { offers: 0, working: 1 } })
      const stop = autorun(() => { runs++; close = issuePages(f.pool).closeFacts('target') })
      try {
        const unrelated = await measureWork(async () => insideReader('unrelated close update', () => {
          f.publish({ type: 'update', rows: [session('foreign-0', { issueId: 'other', archived: true, lastActiveAt: '2026-10-05' })] })
        }), { pool: f.pool })
        expect(runs).toBe(1)
        expect(ids).not.toHaveBeenCalled()
        return { reads: reads.work, unrelated: unrelated.work }
      } finally { stop() }
    } finally { ids.mockRestore(); f.pool.dispose() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('close facts work 1x/4x', JSON.stringify({ first, second }))
  for (const action of ['reads', 'unrelated'] as const)
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(second[action][counter]).toBe(first[action][counter])
})
