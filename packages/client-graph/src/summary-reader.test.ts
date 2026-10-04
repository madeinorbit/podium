import { reaction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { mergePoolSummaries } from './source-registry'
import { LOADING } from './worklist/rollup'

// If hidden() becomes public again, the unused directive fails typecheck.
export function directHiddenControl(pool: MobxPool) {
  // @ts-expect-error Stored summaries are private; callers use row(..., 'summary').
  return pool.hidden('issue', 'cold')
}

const now = Date.parse('2026-10-02T12:00:00Z')
const row = (id: string, archived: boolean) => ({ id, seq: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  stage: archived ? 'done' : 'in_progress', archived, title: 'Declared title', privateBody: 'Must not be stored cold', repoPath: '/synthetic', deps: [],
})
function setup() {
  const cold = row('cold', true), hot = row('hot', false)
  // The feed's per-row read answers what the feed published (POD-5407: a
  // cold row's declared summary is read through it).
  const rows = new Map<string, object>([['cold', cold]])
  const load = vi.fn((_entity: string, id: string) => rows.get(id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined,
    { load, summaries: { issue: ['title'] }, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'cold', value: cold }, { kind: 'issue', id: 'hot', value: hot }] })
  const publish = (id: string, value: object | undefined) => {
    if (value === undefined) rows.delete(id)
    else rows.set(id, value)
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id, value: value as never }] })
  }
  const server: Record<string, object> = { cold, hot }
  // POD-5432: a pending change reaches the pool as the visible row the
  // transaction log painted (`pooled` feed), and its rollback as the server row.
  const paint = (id: string, patch: Record<string, unknown>) => publish(id, { ...server[id], ...patch })
  const rebase = (id: string) => publish(id, server[id])
  return { pool, paint, rebase, publish, load, cold, hot }
}

/**
 * POD-5407: `title` is not one of the rule's inputs the index holds, so a cold
 * row's declared summary is read through the one per-row reader: only these
 * rows, and none of them installed.
 */
function expectSummaryReads(pool: MobxPool, load: ReturnType<typeof vi.fn>, ids: readonly string[]): void {
  expect([...new Set(load.mock.calls.map(([, id]) => id as string))].sort()).toEqual([...ids].sort())
  for (const id of ids) expect(pool.tables.issue.has(id), `${id} not installed`).toBe(false)
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
    expectSummaryReads(pool, load, ['cold'])
  } finally { pool.dispose() }
})

it('summary mode shows a painted change on both resident and cold rows', () => {
  const { pool, paint, load } = setup()
  try {
    paint('cold', { title: 'Pending cold' })
    paint('hot', { title: 'Pending hot' })
    expect(pool.row('issue', 'cold', 'summary')).toMatchObject({ title: 'Pending cold' })
    expect(pool.row('issue', 'hot', 'summary')).toMatchObject({ title: 'Pending hot' })
    expectSummaryReads(pool, load, ['cold'])
  } finally { pool.dispose() }
})

it.each(['summary', 'summary-fields'] as const)('%s follows painted changes and cold/resident transitions without loading', mode => {
  const { pool, paint, rebase, publish, cold, load } = setup()
  const seen: (string | undefined)[] = []
  const stop = reaction(() => {
    const value = pool.row('issue', 'cold', mode)
    return value === LOADING ? 'loading' : (value as { title: string } | undefined)?.title
  }, title => seen.push(title), { fireImmediately: true })
  try {
    expect(seen).toEqual(['Declared title'])
    paint('cold', { title: 'Pending cold' })
    expect(seen.at(-1)).toBe('Pending cold')
    paint('hot', { title: 'Unrelated' })
    expect(seen).toHaveLength(2)
    rebase('cold')
    expect(seen.at(-1)).toBe('Declared title')
    paint('cold', { title: 'Pending again' })
    rebase('cold')
    expect(seen.slice(-2)).toEqual(['Pending again', 'Declared title'])
    expect(pool.hydrate()).toBe(0)
    expectSummaryReads(pool, load, ['cold'])

    expect(pool.row('issue', 'cold')).toBe(LOADING)
    expect(pool.hydrate()).toBe(1)
    paint('cold', { title: 'Pending resident' })
    expect(seen.at(-1)).toBe('Pending resident')
    rebase('cold')
    expect(seen.at(-1)).toBe('Declared title')
    publish('cold', undefined)
    expect(seen.at(-1)).toBeUndefined()
    publish('cold', { ...cold, title: 'Returned cold' })
    expect(pool.tables.issue.has('cold')).toBe(false)
    expect(seen.at(-1)).toBe('Returned cold')
    publish('cold', { ...cold, title: 'Pending returned' })
    expect(seen.at(-1)).toBe('Pending returned')
  } finally { stop(); pool.dispose() }
})

it('a cold model parent follows a painted change without loading the row', () => {
  const { pool, paint, rebase, load } = setup()
  try {
    const issue = pool.issueObject('cold')
    paint('cold', { parentId: 'pending-parent' })
    expect(issue.parentRef).toBe('pending-parent')
    rebase('cold')
    expect(issue.parentRef).toBeNull()
    expect(pool.hydrate()).toBe(0)
    expectSummaryReads(pool, load, ['cold'])
  } finally { pool.dispose() }
})

it('an observed model summary follows an unknown id becoming cold, removal and return', () => {
  const { pool, cold, load, publish } = setup()
  const issue = pool.issueObject('future')
  const seen: (string | null | undefined)[] = []
  const stop = reaction(() => issue.hidden?.parentId, value => seen.push(value), { fireImmediately: true })
  try {
    expect(seen).toEqual([undefined])
    publish('future', { ...cold, id: 'future', parentId: 'cold-parent' })
    expect(seen).toEqual([undefined, 'cold-parent'])
    publish('future', undefined)
    expect(seen.at(-1)).toBeUndefined()
    publish('future', { ...cold, id: 'future', parentId: 'returned-parent' })
    expect(seen.at(-1)).toBe('returned-parent')
    expect(pool.hydrate()).toBe(0)
    expectSummaryReads(pool, load, ['future'])
  } finally { stop(); pool.dispose() }
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
