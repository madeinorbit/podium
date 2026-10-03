import { observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool, type WriteSeam } from './pool'
import { mergePoolSummaries } from './source-registry'
import { LOADING } from './worklist/rollup'

// If hidden() becomes public again, the unused directive fails typecheck.
function directHiddenControl(pool: MobxPool) {
  // @ts-expect-error Stored summaries are private; callers use row(..., 'summary').
  return pool.hidden('issue', 'cold')
}

it('keeps the direct-summary compile-time rejection referenced', () => {
  expect(typeof directHiddenControl).toBe('function')
})

const now = Date.parse('2026-10-02T12:00:00Z')
const row = (id: string, archived: boolean) => ({ id, seq: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  stage: archived ? 'done' : 'in_progress', archived, title: 'Declared title', privateBody: 'Must not be stored cold', repoPath: '/synthetic', deps: [],
})
function setup() {
  const cold = row('cold', true), hot = row('hot', false)
  const load = vi.fn((_entity: string, id: string) => id === 'cold' ? cold : undefined)
  const pending = observable.map<string, Readonly<Record<string, unknown>>>(undefined, { deep: false })
  const writes = { pending: (entity: string, id: string) => pending.get(`${entity}:${id}`), edit: vi.fn() } as unknown as WriteSeam
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined,
    { load, summaries: { issue: ['title'] }, schedule: () => () => {} }, writes)
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'cold', value: cold }, { kind: 'issue', id: 'hot', value: hot }] })
  return { pool, pending, load, cold, hot }
}

it('summary declarations compose and exclude undeclared cold payloads', () => {
  expect(mergePoolSummaries({ issue: ['title'] }, { issue: ['title', 'seq'], session: ['name'] })).toEqual({ issue: ['title', 'seq'], session: ['name'] })
  const { pool, load, hot } = setup()
  try {
    expect(pool.tables.issue.has('cold')).toBe(false)
    const cold = pool.row('issue', 'cold', 'summary')
    expect(cold).toMatchObject({ title: 'Declared title', archived: true })
    expect(cold).not.toHaveProperty('privateBody')
    expect(pool.row('issue', 'hot', 'summary')).toBe(hot)
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally { pool.dispose() }
})

it('summary mode overlays pending edits on both resident and cold rows', () => {
  const { pool, pending } = setup()
  try {
    runInAction(() => { pending.set('issue:cold', { title: 'Pending cold' }); pending.set('issue:hot', { title: 'Pending hot' }) })
    expect(pool.row('issue', 'cold', 'summary')).toMatchObject({ title: 'Pending cold' })
    expect(pool.row('issue', 'hot', 'summary')).toMatchObject({ title: 'Pending hot' })
  } finally { pool.dispose() }
})

it('cold model parent reads overlay pending edits without loading the row', () => {
  const { pool, pending, load } = setup()
  try {
    const issue = pool.issueObject('cold')
    runInAction(() => pending.set('issue:cold', { parentId: 'pending-parent' }))
    expect(issue.parentRef).toBe('pending-parent')
    runInAction(() => pending.clear())
    expect(issue.parentRef).toBeNull()
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally { pool.dispose() }
})

it('a missing cold summary returns LOADING and queues one batched row load', () => {
  const { pool, load } = setup()
  try {
    vi.spyOn(pool.residency!, 'summary').mockReturnValue(undefined)
    expect(pool.row('issue', 'cold', 'summary')).toBe(LOADING)
    expect(pool.row('issue', 'cold', 'summary')).toBe(LOADING)
    expect(load).not.toHaveBeenCalled()
    expect(pool.hydrate()).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(pool.row('issue', 'cold', 'summary')).toMatchObject({ title: 'Declared title' })
    expect(pool.row('issue', 'deleted', 'summary')).toBeUndefined()
  } finally { pool.dispose() }
})
