import { type IssueReferenceSource, issueReferenceModel } from '@podium/client-core/values'
import { LOADING, MobxPool } from '@podium/client-graph'
import { IssueReferences, referenceView } from '@podium/client-graph/issue-reference'
import { omitGone } from '@podium/client-graph/lookup'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { asIssueId } from '@podium/model/browser'
import { describe, expect, it, vi } from 'vitest'
import { historyLoader } from '../../../../tests/worklist/shared/src/history-loader'

function reaction<T>(
  read: () => T,
  paint: (value: T) => void,
  _options: { fireImmediately: boolean },
): () => void {
  const view = createPoolProjection(null as unknown as MobxPool, read)
  paint(view.getSnapshot())
  return view.subscribe(() => paint(view.getSnapshot()))
}

function issue(i: number, patch: Record<string, unknown> = {}) {
  return {
    id: asIssueId(`iss_${i}`),
    seq: i,
    title: `Task ${i}`,
    prefix: 'POD',
    displayRef: `POD-${i}`,
    stage: 'in_progress' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    repoPath: '/r',
    repoId: 'r',
    deps: [],
    ...patch,
  }
}
const repo = {
  kind: 'worktree' as const,
  id: '/r',
  value: {
    path: '/r',
    repoId: 'r',
    prefix: 'POD',
    repoPath: '/r',
    repoName: 'Fixture',
  } as never,
}
function setup(count = 2000) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
  const rows = Array.from({ length: count }, (_, i) => issue(i + 1))
  pool.apply({
    type: 'replace',
    rows: [
      repo,
      ...rows.map((row) => ({ kind: 'issue' as const, id: row.id, value: row as never })),
    ],
  })
  const queue = vi.fn()
  const row = vi.fn(pool.row.bind(pool))
  const refs = new IssueReferences({ row, queries: pool.queries, relations: pool.relations }, queue)
  return {
    pool,
    refs,
    rows,
    queue,
    row,
    dispose() {
      refs.dispose()
      pool.dispose()
    },
  }
}

describe('per-issue pool references', () => {
  it('does work only for the changed issue, with no list scan or peek', () => {
    const f = setup()
    const reads = Array.from({ length: 60 }, () => vi.fn())
    const paints = reads.map(() => vi.fn())
    const stops = reads.map((read, i) =>
      reaction(
        () => {
          read()
          return f.refs.read(`POD-${(i % 20) + 1}`)
        },
        paints[i]!,
        { fireImmediately: true },
      ),
    )
    const scans = [
      vi.spyOn(f.pool.tables.issue, 'keys'),
      vi.spyOn(f.pool.tables.issue, 'values'),
      vi.spyOn(f.pool.tables.issue, 'entries'),
    ]
    const row = f.row
    for (const read of reads) read.mockClear()
    for (const paint of paints) paint.mockClear()
    f.pool.apply({
      type: 'update',
      rows: [
        { kind: 'issue', id: 'iss_1500', value: issue(1500, { title: 'Elsewhere' }) as never },
      ],
    })
    expect(reads.reduce((n, read) => n + read.mock.calls.length, 0)).toBe(0)
    f.pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: 'iss_1', value: issue(1, { title: 'Renamed' }) as never }],
    })
    expect(paints.map((paint) => paint.mock.calls.length)).toEqual(
      Array.from({ length: 60 }, (_, i) => (i % 20 === 0 ? 1 : 0)),
    )
    expect(scans.reduce((n, scan) => n + scan.mock.calls.length, 0)).toBe(0)
    expect(row.mock.calls.some((call) => (call as unknown[])[2] === 'peek')).toBe(false)
    for (const stop of stops) stop()
    for (const scan of scans) scan.mockRestore()
    f.dispose()
  })

  it('redraws only when displayed fields change and follows remove/re-add', async () => {
    const f = setup(1),
      paint = vi.fn()
    const stop = reaction(() => f.refs.read('POD-01'), paint, { fireImmediately: true })
    paint.mockClear()
    f.pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'iss_1',
          value: issue(1, { priority: 0, updatedAt: '2026-09-01T00:00:00.000Z' }) as never,
        },
      ],
    })
    expect(paint).not.toHaveBeenCalled()
    for (const patch of [
      { stage: 'review' },
      { archived: true },
      { deletedAt: '2026-09-01' },
      { title: 'Changed' },
    ]) {
      f.pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: 'iss_1', value: issue(1, patch) as never }],
      })
      expect(paint.mock.calls.at(-1)?.[0]).toEqual(
        issueReferenceModel(issue(1, patch) as IssueReferenceSource),
      )
    }
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'iss_1', value: undefined }] })
    expect(paint.mock.calls.at(-1)?.[0]).toBe(LOADING)
    await Promise.resolve()
    f.refs.resolved('POD-1', null)
    expect(paint.mock.calls.at(-1)?.[0]).toBeNull()
    f.pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: 'iss_1', value: issue(1) as never }],
    })
    expect(paint.mock.calls.at(-1)?.[0]).toMatchObject({
      availability: 'present',
      stage: 'in_progress',
    })
    stop()
    f.dispose()
  })

  it('finds an issue held only as a stub directly and loads its label fields by id', () => {
    const archived = issue(1, { archived: true })
    const history = historyLoader(
      [{ kind: 'issue', id: archived.id, value: archived as never }],
      [archived],
    )
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined, {
      loader: () => history.port,
      schedule: () => () => {},
    })
    pool.apply({ type: 'replace', rows: [repo] })
    const queue = vi.fn(),
      refs = new IssueReferences(pool, queue),
      paint = vi.fn()
    const stop = reaction(() => refs.read('POD-01'), paint, { fireImmediately: true })
    // The stub names the issue at once; only its label fields are on their way.
    expect(refs.id('POD-1')).toBe(archived.id)
    expect(refs.read('POD-1')).toBe(LOADING)
    expect(queue).not.toHaveBeenCalled()
    expect(history.asked).toEqual([['issue', archived.id]])
    expect(history.answer(pool)).toBe(1)
    expect(paint.mock.calls.at(-1)?.[0]).toMatchObject({
      availability: 'archived',
      title: 'Task 1',
    })
    expect(history.asked).toHaveLength(1)
    stop()
    refs.dispose()
    pool.dispose()
  })

  it('loads 50 stub-held labels together and asks the authority only for an observed unknown ref', async () => {
    const cold = Array.from({ length: 50 }, (_, i) => issue(i + 1, { archived: true }))
    const history = historyLoader(
      cold.map((row) => ({ kind: 'issue' as const, id: row.id, value: row as never })),
      cold,
    )
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 }, undefined, {
      loader: () => history.port,
      schedule: () => () => {},
    })
    pool.apply({ type: 'replace', rows: [repo] })
    const queue = vi.fn(),
      refs = new IssueReferences(pool, queue),
      paints = cold.map(() => vi.fn())
    const stops = cold.map((row, i) =>
      reaction(() => refs.read(`POD-${row.seq}`), paints[i]!, { fireImmediately: true }),
    )
    const unknown = vi.fn()
    stops.push(reaction(() => refs.read('POD-999'), unknown, { fireImmediately: true }))
    expect(history.asked).toHaveLength(50)
    expect(paints.every((paint) => paint.mock.calls.at(-1)?.[0] === LOADING)).toBe(true)
    await Promise.resolve()
    expect(queue.mock.calls).toEqual([['POD-999']])
    expect(history.answer(pool)).toBe(50)
    refs.resolved('POD-999', null)
    expect(unknown.mock.calls.at(-1)?.[0]).toBeNull()
    expect(paints.every((paint) => paint.mock.calls.at(-1)?.[0]?.availability === 'archived')).toBe(
      true,
    )
    for (const stop of stops) stop()
    refs.dispose()
    pool.dispose()
  })

  it('refreshes a normalized missing ref when its repository and row arrive', async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const refs = new IssueReferences(pool, vi.fn()),
      paint = vi.fn()
    const stop = reaction(() => refs.read('POD-1'), paint, { fireImmediately: true })
    await Promise.resolve()
    refs.resolved('POD-1', null)
    expect(paint.mock.calls.at(-1)?.[0]).toBeNull()
    const cold = issue(1, { repoId: 'r', prefix: undefined, displayRef: undefined })
    pool.apply({
      type: 'update',
      rows: [repo, { kind: 'issue', id: cold.id, value: cold as never }],
    })
    expect(paint.mock.calls.at(-1)?.[0]).toMatchObject({ ref: 'POD-1', title: 'Task 1' })
    stop()
    refs.dispose()
    pool.dispose()
  })

  it('forgets unresolved scope answers and ignores a response after the chip disappears', async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const queue = vi.fn(),
      refs = new IssueReferences(pool, queue),
      paint = vi.fn()
    const stop = reaction(() => refs.read('POD-1'), paint, { fireImmediately: true })
    await Promise.resolve()
    refs.resolved('POD-1', null)
    expect(paint.mock.calls.at(-1)?.[0]).toBeNull()
    refs.resetUnresolved()
    expect(paint.mock.calls.at(-1)?.[0]).toBe(LOADING)
    expect(queue).toHaveBeenCalledTimes(2)
    stop()
    refs.resolved('POD-1', 'iss_1')
    expect(refs.hasRequest('POD-1')).toBe(false)
    refs.dispose()
    pool.dispose()
  })
})
