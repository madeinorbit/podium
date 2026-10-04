import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

function setup() {
  const cold = {
    id: 'cold',
    seq: 1,
    repoPath: '/fixture',
    title: 'Declared title',
    privateBody: 'Undeclared',
    stage: 'done',
    archived: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deps: [],
  }
  const hot = { ...cold, id: 'hot', archived: false, stage: 'in_progress' }
  // The feed's per-row read answers what the feed published (POD-5407).
  const rows = new Map<string, object>([['cold', cold]])
  const load = vi.fn((_kind: string, id: string) => rows.get(id))
  const pool = new MobxPool(
    { selectedIssueId: null, coarseNow: Date.parse('2026-10-03T12:00:00Z') },
    undefined,
    { load, summaries: { issue: ['title'] }, schedule: () => () => {} },
  )
  pool.apply({
    type: 'replace',
    rows: [cold, hot].map((value) => ({ kind: 'issue' as const, id: value.id, value })),
  })
  // POD-5432: a pending change arrives as the row the transaction log painted.
  const paint = (value: { id: string; title: string }) => {
    if (rows.has(value.id)) rows.set(value.id, value)
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: value.id, value: value as never }] })
  }
  return { pool, paint, load, cold, hot }
}

it('keeps existing worklist decoration and returns declared fields without copying them', () => {
  const { pool, load, hot } = setup()
  try {
    const decorated = pool.row('issue', 'cold', 'summary')
    const fields = pool.row('issue', 'cold', 'summary-fields')
    expect(decorated).toHaveProperty('flatUntil')
    expect(pool.residency?.summary('issue', 'cold')).toHaveProperty('flatUntil')
    expect(fields).not.toHaveProperty('flatUntil')
    expect(fields).toMatchObject({ title: 'Declared title', archived: true })
    expect(fields).not.toHaveProperty('privateBody')
    expect(pool.row('issue', 'cold', 'summary-fields')).toBe(fields)
    expect(pool.row('issue', 'hot', 'summary-fields')).toBe(hot)
    expect(pool.hydrate()).toBe(0)
    // POD-5407: `title` is not one of the rule's inputs the index holds, so
    // the declared summary is read once through the one per-row reader; the
    // row is never installed.
    expect(load.mock.calls).toEqual([['issue', 'cold']])
    expect(pool.tables.issue.has('cold')).toBe(false)
  } finally {
    pool.dispose()
  }
})

it('shows painted summary fields and returns to the declared ones on rollback', () => {
  const { pool, paint, load, cold, hot } = setup()
  try {
    const original = pool.row('issue', 'cold', 'summary-fields')
    paint({ ...cold, title: 'Pending cold' })
    paint({ ...hot, title: 'Pending hot' })
    expect(pool.row('issue', 'cold', 'summary-fields')).toMatchObject({ title: 'Pending cold' })
    expect(pool.row('issue', 'hot', 'summary-fields')).toMatchObject({ title: 'Pending hot' })
    expect(original).toMatchObject({ title: 'Declared title' })
    paint(cold)
    expect(pool.row('issue', 'cold', 'summary-fields')).toMatchObject({ title: 'Declared title' })
    expect(pool.hydrate()).toBe(0)
    // Read through the one per-row reader, never installed (POD-5407).
    expect(new Set(load.mock.calls.map(([, id]) => id))).toEqual(new Set(['cold']))
    expect(pool.tables.issue.has('cold')).toBe(false)
  } finally {
    pool.dispose()
  }
})

it('loads a missing declared summary once and resolves through the same reader', () => {
  const { pool, load } = setup()
  try {
    vi.spyOn(pool.residency!, 'summary').mockReturnValue(undefined)
    expect(pool.row('issue', 'cold', 'summary-fields')).toBe(LOADING)
    expect(pool.row('issue', 'cold', 'summary-fields')).toBe(LOADING)
    expect(load).not.toHaveBeenCalled()
    expect(pool.hydrate()).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(pool.row('issue', 'cold', 'summary-fields')).toMatchObject({ title: 'Declared title' })
    expect(pool.row('issue', 'unknown', 'summary-fields')).toBeUndefined()
  } finally {
    pool.dispose()
  }
})
