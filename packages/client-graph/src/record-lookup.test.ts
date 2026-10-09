import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { LOADING } from './loading'
import { here, isGone, omitGone, type Lookup } from './lookup'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PoolRowSlot } from './react/row'

const now = Date.parse('2026-10-09T00:00:00Z')
const issue = (id: string, cold = false) => ({
  id, seq: 1, title: id, repoPath: '/synthetic',
  createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
  stage: cold ? 'done' : 'in_progress',
  ...(cold ? { closedAt: '2020-01-01T00:00:00Z' } : {}),
})

/** The pre-migration answers, on the very same tables/index as the candidate.
 * Preserve this control after deleting the old production reader. */
function oldRow(pool: MobxPool, id: string) {
  return pool.tables.issue.get(id) ?? (pool.residency?.loading('issue', id) ? LOADING : undefined)
}
function oldModel(pool: MobxPool, id: string) {
  return pool.tables.issue.has(id) ? pool.issueObject(id) : undefined
}

function fixture() {
  const rows = new Map([['hot', issue('hot')], ['cold', issue('cold', true)]])
  const exits = new Map<string, 'removed' | 'evicted'>([['deleted', 'removed'], ['evicted', 'evicted']])
  const load = vi.fn((_entity: string, id: string) => rows.get(id))
  const schedule = vi.fn(() => () => {})
  const options = { load, schedule, exitKind: (_entity: string, id: string) => exits.get(id) }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, options)
  pool.apply({ type: 'replace', rows: [...rows].map(([id, value]) => ({ kind: 'issue' as const, id, value })) })
  return { pool, rows, exits, load, schedule }
}

it('compares the old and new answers on resident, cold, removed and inaccessible fixtures', () => {
  const f = fixture()
  try {
    expect(f.pool.row('issue', 'hot')).toBe(oldRow(f.pool, 'hot'))
    expect(f.pool.model('issue', 'hot')).toBe(oldModel(f.pool, 'hot'))
    expect(f.pool.row('issue', 'cold')).toBe(oldRow(f.pool, 'cold'))
    expect(oldModel(f.pool, 'cold')).toBeUndefined()
    expect(f.pool.model('issue', 'cold')).toBe(LOADING)
    expect(oldRow(f.pool, 'deleted')).toBeUndefined()
    expect(f.pool.row('issue', 'deleted')).toEqual({ kind: 'gone', reason: 'removed' })
    expect(f.pool.model('issue', 'deleted')).toEqual({ kind: 'gone', reason: 'removed' })
    expect(f.pool.row('issue', 'private')).toBe(LOADING)
    f.pool.hydrate()
    expect(f.pool.row('issue', 'private')).toEqual({ kind: 'gone', reason: 'not-visible' })
    expect(f.pool.model('issue', 'private')).toEqual({ kind: 'gone', reason: 'not-visible' })
    // Existing nullable/list callers deliberately keep their former answers.
    expect(here(f.pool.model('issue', 'cold'))).toBe(oldModel(f.pool, 'cold'))
    expect(omitGone(f.pool.row('issue', 'deleted'))).toBe(oldRow(f.pool, 'deleted'))
    expect(here(f.pool.model('issue', 'deleted'))).toBe(oldModel(f.pool, 'deleted'))
  } finally { f.pool.dispose() }
})

it('a server-deleted cold record never starts another load', () => {
  const f = fixture()
  try {
    f.exits.set('cold', 'removed')
    f.rows.delete('cold')
    expect(f.pool.row('issue', 'cold')).toEqual({ kind: 'gone', reason: 'removed' })
    expect(f.pool.model('issue', 'cold')).toEqual({ kind: 'gone', reason: 'removed' })
    expect(f.pool.row('issue', 'deleted', 'summary')).toEqual({ kind: 'gone', reason: 'removed' })
    expect(f.pool.hydrate()).toBe(0)
    expect(f.schedule).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
  } finally { f.pool.dispose() }
})

it('the row boundary displays pending once and never spins for a deleted or inaccessible record', () => {
  const f = fixture()
  const render = (id: string) => renderToStaticMarkup(createElement(PoolRowSlot, {
    pool: f.pool, id,
    renderRow: row => createElement('span', null, row.id),
    renderLoading: () => createElement('span', null, 'loading'),
  }))
  try {
    expect(render('hot')).toBe('<span>hot</span>')
    expect(render('cold')).toBe('<span>loading</span>')
    expect(render('deleted')).toBe('')
    expect(render('private')).toBe('<span>loading</span>')
    f.pool.hydrate()
    expect(render('private')).toBe('')
    expect(render('deleted')).toBe('')
  } finally { f.pool.dispose() }
})

// Compiled by the full typecheck; never invoked. The raw APIs force narrowing
// before reading record fields and cannot silently answer undefined.
function lookupTypes(pool: MobxPool) {
  const model = pool.model('issue', 'id')
  const row = pool.row('issue', 'id')
  // @ts-expect-error handle loading and Gone before reading model fields
  void model.title
  // @ts-expect-error handle loading and Gone before reading stored fields
  void row.id
  // @ts-expect-error an addressed lookup never returns undefined
  const absent: undefined = model
  if (model !== LOADING && !isGone(model)) void model.title
  if (row !== LOADING && !isGone(row)) void row.id
  const complete: Lookup<unknown> = model
  void absent; void complete
}
void lookupTypes

it('batches cold, unknown and evicted requests and reloads the evicted record', () => {
  const f = fixture()
  try {
    f.rows.set('evicted', issue('evicted'))
    expect(f.pool.model('issue', 'cold')).toBe(LOADING)
    expect(f.pool.model('issue', 'evicted')).toBe(LOADING)
    expect(f.pool.row('issue', 'cold')).toBe(LOADING)
    expect(f.schedule).toHaveBeenCalledTimes(1)
    expect(f.load).not.toHaveBeenCalled()
    expect(f.pool.hydrate()).toBe(2)
    expect(f.pool.row('issue', 'cold')).toBe(f.rows.get('cold'))
    expect(f.pool.row('issue', 'evicted')).toBe(f.rows.get('evicted'))
    expect(f.load).toHaveBeenCalledTimes(2)
    expect(f.pool.model('issue', 'evicted')).toBe(f.pool.issueObject('evicted'))
  } finally { f.pool.dispose() }
})

it('a deletion wakes its observer to gone and never queues another load', () => {
  const f = fixture()
  const answers: unknown[] = []
  const stop = autorun(() => { answers.push(f.pool.model('issue', 'hot')) })
  try {
    runInAction(() => {
      f.rows.delete('hot'); f.exits.set('hot', 'removed')
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'hot', value: undefined }] })
    })
    expect(answers.at(-1)).toEqual({ kind: 'gone', reason: 'removed' })
    expect(answers).not.toContain(LOADING)
    for (let n = 0; n < 3; n++) {
      expect(f.pool.row('issue', 'hot')).toEqual({ kind: 'gone', reason: 'removed' })
      f.pool.hydrate()
    }
    expect(f.load).not.toHaveBeenCalled()
    expect(f.schedule).not.toHaveBeenCalled()
  } finally { stop(); f.pool.dispose() }
})

it('a failed load settles once, and a later publication makes the record available again', () => {
  const f = fixture()
  const answers: unknown[] = []
  const stop = autorun(() => { answers.push(f.pool.row('issue', 'private')) })
  try {
    expect(answers.at(-1)).toBe(LOADING)
    f.pool.hydrate()
    expect(answers.at(-1)).toEqual({ kind: 'gone', reason: 'not-visible' })
    expect(f.pool.row('issue', 'private')).toEqual({ kind: 'gone', reason: 'not-visible' })
    expect(f.pool.hydrate()).toBe(0)
    expect(f.load).toHaveBeenCalledTimes(1)
    const value = issue('private')
    f.rows.set('private', value)
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'private', value }] })
    expect(answers.at(-1)).toBe(value)
  } finally { stop(); f.pool.dispose() }
})
