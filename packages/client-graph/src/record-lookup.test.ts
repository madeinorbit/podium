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
