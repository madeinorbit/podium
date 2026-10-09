import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { LOADING } from './loading'
import { here, isGone, omitGone, type Gone, type Lookup } from './lookup'
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
  if (row !== LOADING) {
    // @ts-expect-error checking only loading leaves Gone to handle
    void row.id
  }
  if (model !== LOADING) {
    // @ts-expect-error checking only loading leaves Gone to handle
    void model.title
  }
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

it('compares old and new resident identity subscriptions while fields stay live', () => {
  const f = fixture()
  const oldAnswers: unknown[] = [], answers: unknown[] = [], titles: unknown[] = []
  const oldStop = autorun(() => { oldAnswers.push(oldModel(f.pool, 'hot')) })
  const stop = autorun(() => { answers.push(f.pool.model('issue', 'hot')) })
  const fieldsStop = autorun(() => { titles.push(f.pool.issueObject('hot').title) })
  try {
    expect(answers).toEqual(oldAnswers)
    const value = { ...f.rows.get('hot')!, title: 'renamed' }
    f.rows.set('hot', value)
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'hot', value }] })
    // A payload update changes fields, never the addressed model's identity
    // or availability. It must not wake every join holding that identity.
    expect(oldAnswers).toHaveLength(1)
    expect(answers).toEqual(oldAnswers)
    expect(titles).toEqual(['hot', 'renamed'])
    runInAction(() => {
      f.rows.delete('hot'); f.exits.set('hot', 'removed')
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'hot', value: undefined }] })
    })
    expect(oldAnswers).toHaveLength(2)
    expect(oldAnswers.at(-1)).toBeUndefined()
    expect(answers).toHaveLength(2)
    expect(answers.at(-1)).toEqual({ kind: 'gone', reason: 'removed' })
    expect(answers).not.toContain(LOADING)
    expect(f.load).not.toHaveBeenCalled()
  } finally { oldStop(); stop(); fieldsStop(); f.pool.dispose() }
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

it('resident observes presence without subscribing to payload changes', () => {
  const f = fixture()
  const presence: boolean[] = [], answers: string[] = [], titles: unknown[] = []
  const presenceStop = autorun(() => { presence.push(f.pool.tables.issue.has('hot')) })
  const stop = autorun(() => { answers.push(f.pool.resident('issue', 'hot')) })
  const fieldsStop = autorun(() => { titles.push(f.pool.issueObject('hot').title) })
  try {
    expect(answers).toEqual(['resident'])
    const value = { ...f.rows.get('hot')!, title: 'renamed' }
    f.rows.set('hot', value)
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'hot', value }] })
    expect(titles).toEqual(['hot', 'renamed'])
    expect(presence).toEqual([true])
    expect(answers).toEqual(['resident'])
    runInAction(() => {
      f.rows.delete('hot'); f.exits.set('hot', 'removed')
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'hot', value: undefined }] })
    })
    expect(presence).toEqual([true, false])
    expect(answers).toEqual(['resident', 'absent'])
    expect(f.schedule).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
    f.exits.delete('hot')
    f.rows.set('hot', value)
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'hot', value }] })
    expect(presence).toEqual([true, false, true])
    expect(answers).toEqual(['resident', 'absent', 'resident'])
  } finally { presenceStop(); stop(); fieldsStop(); f.pool.dispose() }
})

it('resident keeps loading and absence transitions live', () => {
  const f = fixture()
  const cold: string[] = [], missing: string[] = []
  const coldStop = autorun(() => { cold.push(f.pool.resident('issue', 'cold')) })
  const missingStop = autorun(() => { missing.push(f.pool.resident('issue', 'private')) })
  try {
    expect(cold).toEqual(['loading'])
    expect(missing).toEqual(['loading'])
    expect(f.pool.resident('issue', 'deleted')).toBe('absent')
    expect(f.pool.hydrate()).toBe(1)
    expect(cold).toEqual(['loading', 'resident'])
    expect(missing).toEqual(['loading', 'absent'])
    expect(f.pool.resident('issue', 'private')).toBe('absent')
    expect(f.pool.hydrate()).toBe(0)
    expect(f.load).toHaveBeenCalledTimes(2)
    const value = issue('private')
    f.rows.set('private', value)
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'private', value }] })
    expect(missing).toEqual(['loading', 'absent', 'resident'])
  } finally { coldStop(); missingStop(); f.pool.dispose() }
})

it('keeps the old Gone guard answers and property reads on the same fixtures', () => {
  // Keep the original eager guard as the equivalence control for its smaller
  // replacement. Tags alone must not turn ordinary values into terminal exits.
  const oldIsGone = (value: unknown): value is Gone =>
    typeof value === 'object' && value !== null &&
    (value as Gone).kind === 'gone' &&
    ((value as Gone).reason === 'removed' || (value as Gone).reason === 'not-visible')
  const values: unknown[] = [
    null, undefined, LOADING, false, 0, 'gone', {}, issue('resident'),
    { kind: 'gone', reason: 'removed' },
    { kind: 'gone', reason: 'not-visible' },
    { kind: 'gone', reason: 'evicted' },
    { kind: 'gone' }, { kind: 'issue', reason: 'removed' },
    Object.assign(() => {}, { kind: 'gone', reason: 'removed' }),
    Object.assign([], { kind: 'gone', reason: 'removed' }),
  ]
  for (const value of values) {
    const gone = oldIsGone(value)
    expect(isGone(value)).toBe(gone)
    expect(omitGone(value)).toBe(gone ? undefined : value)
    expect(here(value)).toBe(value === LOADING || gone ? undefined : value)
  }
  for (const reason of ['removed', 'not-visible', 'evicted']) {
    const reads: string[] = []
    const value = {
      get kind() { reads.push('kind'); return 'gone' },
      get reason() { reads.push('reason'); return reason },
    }
    const oldAnswer = oldIsGone(value)
    const oldReads = reads.splice(0)
    expect(isGone(value)).toBe(oldAnswer)
    expect(reads).toEqual(oldReads)
  }
})
