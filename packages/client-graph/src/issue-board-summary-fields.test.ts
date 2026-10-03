import { observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool, type WriteSeam } from './pool'
import { LOADING } from './worklist/rollup'

function setup() {
  const cold = {
    id: 'cold',
    title: 'Declared title',
    privateBody: 'Undeclared',
    stage: 'done',
    archived: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deps: [],
  }
  const hot = { ...cold, id: 'hot', archived: false, stage: 'in_progress' }
  const load = vi.fn((_kind: string, id: string) => (id === 'cold' ? cold : undefined))
  const pending = observable.map<string, Readonly<Record<string, unknown>>>(undefined, {
    deep: false,
  })
  const writes = {
    pending: (_kind: string, id: string) => pending.get(id),
    edit: vi.fn(),
  } as unknown as WriteSeam
  const pool = new MobxPool(
    { selectedIssueId: null, coarseNow: Date.parse('2026-10-03T12:00:00Z') },
    undefined,
    { load, summaries: { issue: ['title'] }, schedule: () => () => {} },
    writes,
  )
  pool.apply({
    type: 'replace',
    rows: [cold, hot].map((value) => ({ kind: 'issue' as const, id: value.id, value })),
  })
  return { pool, pending, load, hot }
}

it('keeps existing worklist decoration and returns declared fields without copying them', () => {
  const { pool, load, hot } = setup()
  try {
    const decorated = pool.row('issue', 'cold', 'summary')
    const fields = pool.row('issue', 'cold', 'summary-fields')
    expect(decorated).toHaveProperty('flatUntil')
    expect(fields).not.toHaveProperty('flatUntil')
    expect(fields).toMatchObject({ title: 'Declared title', archived: true })
    expect(fields).not.toHaveProperty('privateBody')
    expect(pool.row('issue', 'cold', 'summary-fields')).toBe(fields)
    expect(pool.row('issue', 'hot', 'summary-fields')).toBe(hot)
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally {
    pool.dispose()
  }
})

it('overlays pending summary fields and restores the original declared object', () => {
  const { pool, pending } = setup()
  try {
    const original = pool.row('issue', 'cold', 'summary-fields')
    runInAction(() => {
      pending.set('cold', { title: 'Pending cold' })
      pending.set('hot', { title: 'Pending hot' })
    })
    expect(pool.row('issue', 'cold', 'summary-fields')).toMatchObject({ title: 'Pending cold' })
    expect(pool.row('issue', 'hot', 'summary-fields')).toMatchObject({ title: 'Pending hot' })
    expect(original).toMatchObject({ title: 'Declared title' })
    runInAction(() => pending.delete('cold'))
    expect(pool.row('issue', 'cold', 'summary-fields')).toBe(original)
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
