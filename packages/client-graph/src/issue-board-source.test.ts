import { issueBoardStats } from '@podium/client-core/perf'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createIssueBoardSource } from './issue-board-source'
import { ISSUE_BOARD_SUMMARIES } from './issue-board-schema'
import { MobxPool, type WriteSeam } from './pool'
import { LOADING } from './worklist/rollup'

const now = Date.parse('2026-10-03T12:00:00Z')
const row = (id: string, overrides: object = {}) => ({ id, seq: 1, title: id, description: { value: 'Searchable body' },
  stage: 'in_progress', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  priority: 2, type: 'task', labels: [], audience: 'human' as const, repoPath: '/fixture', deps: [], ...overrides })
function setup(rows = [row('hot'), row('cold', { archived: true, stage: 'done' })]) {
  const load = vi.fn((_entity: string, id: string) => rows.find(row => row.id === id))
  const pending = observable.map<string, Record<string, unknown>>(undefined, { deep: false })
  const writes = { pending: (_entity: string, id: string) => pending.get(id), edit: vi.fn() } as unknown as WriteSeam
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined,
    { load, summaries: ISSUE_BOARD_SUMMARIES, schedule: () => () => {} }, writes)
  pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue' as const, id: value.id, value })) })
  const source = createIssueBoardSource(pool)
  return { pool, source, load, pending, stop: () => { source.dispose(); pool.dispose() } }
}
it('releases demanded ID results on filter change and unmount', () => {
  const { source, stop } = setup()
  const query = observable.box('in_progress')
  const unmount = autorun(() => source.queryIds({ kind: 'board', filter: { stage: query.get() as 'in_progress' } }))
  try {
    expect(source.stats().demandKeys).toBe(1)
    runInAction(() => query.set('planning'))
    expect(source.stats().demandKeys).toBe(1)
    unmount()
    expect(source.stats().demandKeys).toBe(0)
  } finally { unmount(); stop() }
})
it('uses declared cold summaries without promoting cards or hydrating the world', () => {
  const { source, pool, load, stop } = setup([row('hot'), row('cold', { archived: true, stage: 'done', defaultAgent: 'codex' })])
  try {
    expect(source.queryIds({ kind: 'board', filter: { archived: true } })).toEqual({ ids: ['cold', 'hot'] })
    expect(source.issue('cold')).toMatchObject({ id: 'cold', description: 'Searchable body', stage: 'done', defaultAgent: 'codex' })
    expect(pool.tables.issue.has('cold')).toBe(false)
    expect(source.stats().residentRows).toBe(1)
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally { stop() }
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
  } finally { stop() }
})
it('stage changes examine the matching resident bucket, independent of hidden residents', () => {
  const { source, stop } = setup([row('visible', { stage: 'planning' }), ...Array.from({ length: 1500 }, (_, n) => row(`hidden-${n}`))])
  issueBoardStats.enable(); issueBoardStats.reset()
  try {
    expect(source.queryIds({ kind: 'board', filter: { stage: 'planning' } })).toEqual({ ids: ['visible'] })
    expect(issueBoardStats.read().residentCandidates).toBe(1)
    expect(issueBoardStats.read().coldSummaryVisits).toBe(0)
  } finally { issueBoardStats.disable(); stop() }
})
it('keeps an empty review with a discovered continuation out of Needs you', () => {
  const { source, stop } = setup([row('origin', { stage: 'review' }), row('tip', { deps: [{ id: 'origin', type: 'discovered-from' }] })])
  try { expect(source.queryIds({ kind: 'explorer', tab: 'needs' })).toEqual({ ids: [] }) }
  finally { stop() }
})
it('preserves an opaque parent reference without loading an absent parent', () => {
  const { source, pool, load, stop } = setup([row('child', { parentId: 'absent-parent' })])
  try {
    expect(source.issue('child')).toMatchObject({ parentId: 'absent-parent' })
    expect(source.queryIds({ kind: 'board' })).toEqual({ ids: ['child'] })
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
  } finally { stop() }
})
it('updates overlays, parent scope, archive and replacement without a cold standing index', () => {
  const { source, pool, pending, stop } = setup([row('parent'), row('child', { audience: 'agent', parentId: 'parent' }), row('draft', { isDraftVessel: true })])
  let ids: string[] = []
  const off = autorun(() => { const value = source.queryIds({ kind: 'board' }); if (value && value !== LOADING) ids = value.ids })
  try {
    expect(ids).toEqual(['child', 'parent'])
    runInAction(() => pending.set('parent', { audience: 'agent' }))
    expect(ids).toEqual([])
    runInAction(() => pending.delete('parent'))
    expect(ids).toEqual(['child', 'parent'])
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'parent', value: row('parent', { stage: 'done', archived: true }) }] })
    // The pool retains an already resident ancestor; the board does not own
    // cutoff policy. Its index must mirror exactly the resident population.
    expect(source.stats().residentRows).toBe(pool.tables.issue.size)
    expect(source.issue('parent')).toMatchObject({ archived: true })
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'replacement', value: row('replacement') }] })
    expect(ids).toEqual(['replacement'])
    expect(source.stats().residentRows).toBe(1)
  } finally { off(); stop() }
})
