import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { ReaderQueries } from './reader-queries'
import { createColdIndex } from './shared/cold-index'
import { createReaderIndex, type ReaderQuestion } from './shared/reader-questions'
import { createRelationIndex } from './shared/relation-index'
import { SCHEMA } from './shared/schema'
import type { RowSourceEvent } from './shared/source'
import { createObservableTables } from './tables'
import { workProbe, type PrimitiveWork } from './primitive-work.test.helpers'
import { LOADING } from './worklist/rollup'

const actions = ['row', 'membership', 'irrelevant'] as const
type Change = typeof actions[number]
const question: ReaderQuestion = { kind: 'boardIssues', priority: 1 }
const issue = (id: string, priority = 1) => ({
  id, title: 'Title', priority, stage: 'planning', archived: false,
  seq: 1, repoId: 'repo', repoPath: '/repo', parentId: 'owner',
  createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
  audience: 'human', labels: [], deps: [],
})
type ProbeRow = ReturnType<typeof issue> & { description?: string }
type ProbeRecord = { kind: 'issue'; id: string; value: ProbeRow }
function records(scale: number): ProbeRecord[] {
  return [
    { kind: 'issue', id: 'a', value: issue('a') },
    { kind: 'issue', id: 'b', value: issue('b') },
    ...Array.from({ length: 128 * scale }, (_, index): ProbeRecord => ({
      kind: 'issue', id: `unrelated-${index}`,
      value: { ...issue(`unrelated-${index}`, 3), parentId: `elsewhere-${index}` },
    })),
  ]
}
function changed(change: Change): ProbeRecord {
  return change === 'row'
    ? { kind: 'issue', id: 'a', value: { ...issue('a'), title: 'Changed' } }
    : change === 'membership'
      ? { kind: 'issue', id: 'b', value: { ...issue('b', 2), parentId: 'elsewhere' } }
      : { kind: 'issue', id: 'unrelated-0', value: {
        ...issue('unrelated-0', 3), parentId: 'elsewhere-0', description: 'Private change',
      } }
}
function report(name: string, change: Change, one: PrimitiveWork, four: PrimitiveWork) {
  console.info(`[primitive bounds] ${name}/${change} ${JSON.stringify({ one, four })}`)
}
function flat(name: string, change: Change, measure: (scale: number) => PrimitiveWork) {
  const one = measure(1), four = measure(4)
  report(name, change, one, four)
  // Exact equality, including repeated visits. No growth allowances.
  expect(four).toEqual(one)
}

describe('generic primitive change bounds (128/512 unrelated rows)', () => {
  it.each(actions)('declared source query: %s', change => {
    flat('declared source query', change, scale => {
      const probe = workProbe(), index = createReaderIndex()
      index.apply({ type: 'replace', rows: records(scale) })
      const record = changed(change)
      record.value = new Proxy(record.value, {
        get(target, key, receiver) { probe.count('reads'); return Reflect.get(target, key, receiver) },
      })
      const measured = probe.measure(() => {
        index.apply({ type: 'update', rows: [record] })
        return { ids: index.ids(question), has: index.contains(question, record.id), revision: index.revision(question) }
      })
      expect(measured.value.ids).toEqual(change === 'membership' ? ['a'] : ['a', 'b'])
      expect(measured.value.has).toBe(change === 'row')
      expect(measured.work.reads).toBeGreaterThan(0)
      return measured.work
    })
  })
  it.each(actions)('relation index: %s', change => {
    flat('relation index', change, scale => {
      const probe = workProbe(), index = createRelationIndex(SCHEMA)
      index.begin()
      for (const record of records(scale)) index.changed('issue', record.id, false, record.value)
      index.flush()
      const record = changed(change)
      const row = new Proxy(record.value, {
        get(target, key, receiver) { probe.count('reads'); return Reflect.get(target, key, receiver) },
      })
      const measured = probe.measure(() => {
        index.begin()
        index.changed('issue', record.id, true, row)
        return { delta: index.flush(), members: index.members('issue', 'owner', 'children') }
      })
      expect([...measured.value.members]).toEqual(change === 'membership' ? ['a'] : ['a', 'b'])
      expect(index.forward('issue', record.id, 'parent')).toBe(
        change === 'row' ? 'owner' : change === 'membership' ? 'elsewhere' : 'elsewhere-0',
      )
      expect(measured.value.delta.buckets.length > 0).toBe(change === 'membership')
      expect(measured.work.reads).toBeGreaterThan(0)
      return measured.work
    })
  })
  it.each(actions)('createQueryResult with fixed demand: %s', change => {
    flat('createQueryResult fixed demand', change, scale => queryResult(scale, change, false))
  })
  it.each(actions)('createQueryResult with growing demand: %s', change => {
    const one = queryResult(1, change, true), four = queryResult(4, change, true)
    report('createQueryResult growing demand', change, one, four)
    expect(four.reads).toBe(one.reads)
    expect(four.visits).toBe(one.visits)
    expect(four.lookups).toBe(one.lookups)
    // Actual ordering-scalar comparisons: at most two AVL paths per edit,
    // logarithmic in demand rather than a membership scan.
    for (const [count, work] of [[130, one], [514, four]] as const)
      expect(work.comparisons).toBeLessThanOrEqual(8 * Math.ceil(Math.log2(count + 1)))
  })
  for (const surface of ['ids', 'project'] as const) {
    it.each(actions)('ReaderQueries.' + surface + ': %s', change => {
      flat(`ReaderQueries.${surface}`, change, scale => readerQueries(scale, change, surface))
    })
  }
})

function queryResult(scale: number, change: Change, broad: boolean): PrimitiveWork {
  const probe = workProbe()
  const rows = observable.map(records(scale).map(record => [record.id, record.value] as const), { deep: false })
  const orders = new Map<string, string>()
  for (const id of rows.keys()) orders.set(id, {
    [Symbol.toPrimitive]() { probe.count('comparisons'); return id },
  } as unknown as string)
  let membership: ((id: string | undefined) => void) | undefined
  const has = (id: string) => broad ? rows.has(id) : rows.get(id)?.priority === 1
  const result = createQueryResult({
    name: 'primitive query result', ids: () => [...rows.keys()].filter(has), has,
    read: id => {
      probe.count('reads')
      const row = rows.get(id)
      return row ? { id, title: row.title } : undefined
    },
    order: id => orders.get(id)!, matches: [value => value.title === 'Changed'],
    subscribe: listener => { membership = listener; return () => { membership = undefined } },
  })
  let current: { id: string; title: string }[] = []
  let matched: number | typeof LOADING | undefined
  const stop = autorun(() => {
    const value = result.get()
    if (value === undefined || value === LOADING) throw new Error('Expected loaded query')
    current = value
    matched = result.countMatch(0)
  })
  const previous = current
  try {
    const record = changed(change)
    const measured = probe.measure(() => runInAction(() => {
      if (change === 'membership') rows.delete(record.id)
      else rows.set(record.id, record.value)
      membership?.(record.id)
    }))
    const expected = records(scale)
      .filter(record => (broad || record.value.priority === 1) && !(change === 'membership' && record.id === 'b'))
      .map(record => ({ id: record.id, title: change === 'row' && record.id === 'a' ? 'Changed' : 'Title' }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    expect([...current]).toEqual(expected)
    expect(matched).toBe(change === 'row' ? 1 : 0)
    expect(previous.find(row => row.id === 'a')?.title).toBe('Title')
    expect(previous.some(row => row.id === 'b')).toBe(true)
    if (change === 'irrelevant') expect(current).toBe(previous)
    expect(measured.work.reads).toBe(change === 'row' || (broad && change === 'irrelevant') ? 1 : 0)
    return measured.work
  } finally { stop(); result.dispose() }
}

function readerQueries(scale: number, change: Change, surface: 'ids' | 'project'): PrimitiveWork {
  const probe = workProbe(), initial = records(scale), source = createColdIndex(SCHEMA)
  source.apply({ type: 'replace', rows: initial })
  const rows = observable.map(initial.map(record => [record.id, record.value] as const), { deep: false })
  // Drive ReaderQueries directly, excluding pool ingestion and screen work.
  const pool = { tables: createObservableTables(), row: (_kind: string, id: string) => rows.get(id) }
  const queries = new ReaderQueries(pool as unknown as MobxPool, SCHEMA, () => source)
  queries.publish({ type: 'replace', rows: initial })
  let current: unknown[] = []
  const stop = autorun(() => {
    const value = surface === 'ids' ? queries.ids(question) : queries.project(question, 'primitive projection', id => {
      probe.count('reads')
      const row = rows.get(id)
      return row ? { id, title: row.title } : undefined
    })
    if (value === undefined || value === LOADING) throw new Error('Expected loaded query')
    current = value
  })
  try {
    const record = changed(change), event: RowSourceEvent = { type: 'update', rows: [record] }
    // Source maintenance is measured separately; count only this primitive.
    source.apply(event)
    const measured = probe.measure(() => runInAction(() => {
      rows.set(record.id, record.value)
      queries.publish(event)
    }))
    const ids = change === 'membership' ? ['a'] : ['a', 'b']
    expect([...current]).toEqual(surface === 'ids' ? ids : ids.map(id => ({
      id, title: change === 'row' && id === 'a' ? 'Changed' : 'Title',
    })))
    expect(measured.work.reads).toBe(surface === 'project' && change === 'row' ? 1 : 0)
    return measured.work
  } finally { stop(); queries.dispose() }
}

it('the lightweight probe detects real iteration and restores methods after failure', () => {
  const probe = workProbe(), original = Set.prototype.values
  const one = probe.measure(() => [...new Set(Array.from({ length: 128 }, (_, i) => i))]).work
  const four = probe.measure(() => [...new Set(Array.from({ length: 512 }, (_, i) => i))]).work
  expect(four.visits).toBe(one.visits * 4)
  expect(() => probe.measure(() => { throw new Error('stop') })).toThrow('stop')
  expect(Set.prototype.values).toBe(original)
})
