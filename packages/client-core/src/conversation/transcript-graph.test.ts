import type { TranscriptItem } from '@podium/model'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { computeTranscript } from '../values/transcript-compute'
import { TranscriptGraph, type TranscriptGraphChange } from './transcript-graph'

const prose = (id: string, text = id): TranscriptItem => ({ id, role: 'assistant', text })
const user = (id: string, text = id): TranscriptItem => ({ id, role: 'user', text })
const call = (id: string, use = 'same', name = 'Read'): TranscriptItem =>
  ({ id, role: 'tool', text: '', toolName: name, toolUseId: use })
const result = (id: string, use = 'same', text = id): TranscriptItem =>
  ({ id, role: 'tool', text: '', toolUseId: use, toolResult: text })
const media = (id: string, kind: 'image' | 'file' = 'image'): TranscriptItem =>
  ({ id, role: 'user', text: '', toolPaths: [`/${id}`], tags: [{ kind, label: id }] })
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

function fixture(initial: TranscriptItem[]) {
  let items = initial
  const graph = new TranscriptGraph(items)
  const check = () => {
    for (const verbosity of ['normal', 'summary', 'verbose'] as const) {
      const expected = computeTranscript({ items, verbosity, query: '', cursor: 0 })
      expect(plain(graph.snapshot(verbosity))).toEqual(plain(expected))
      for (const query of ['', ' SAME ', 'file', 'error', 'needle', 'a\nb']) {
        const total = computeTranscript({ items, verbosity, query, cursor: 0 }).search.total
        for (const cursor of [0, 1, total + 1])
          expect(graph.search(query, cursor, verbosity)).toEqual(
            computeTranscript({ items, verbosity, query, cursor }).search,
          )
      }
    }
  }
  const apply = (change: TranscriptGraphChange) => {
    const values = new Map(items.map(item => [item.id, item]))
    for (const item of change.changed) values.set(item.id, item)
    const removed = new Set(change.removed)
    const ids = items.map(item => item.id).filter(id => !removed.has(id))
    for (const insertion of change.insertions ?? []) {
      const before = insertion.before === undefined ? ids.length : ids.indexOf(insertion.before)
      ids.splice(before < 0 ? ids.length : before, 0, insertion.id)
    }
    items = ids.map(id => values.get(id)!)
    graph.apply(change)
    check()
  }
  const append = (...changed: TranscriptItem[]) => apply({ changed, insertions: changed.map(item => ({ id: item.id })) })
  const prepend = (...changed: TranscriptItem[]) => apply({ changed, insertions: changed.map(item => ({ id: item.id, before: items[0]?.id })) })
  check()
  return { graph, check, apply, append, prepend }
}

it('pairs reused tool IDs, last results and effects across the loaded page seam', () => {
  const f = fixture([result('orphan'), prose('a')])
  f.prepend(call('early'))
  f.append(call('late'), result('r1', 'same', 'first'), result('r2', 'same', 'error: needle'))
  f.apply({ changed: [{ ...result('r1'), toolEffects: [{ kind: 'unknown', key: '/a' }] }] })
  f.apply({ changed: [result('r2', 'same', 'last')] })
  f.append(prose('separator'), call('interactive', 'ask', 'AskUserQuestion'))
})

it('folds image/file markers through paired results and repairs the older-page seam', () => {
  const f = fixture([media('image'), media('file', 'file'), prose('after')])
  f.prepend(user('prompt'))
  f.append(call('call'), user('next'), result('r'), media('attachment'), media('chip', 'file'))
  f.apply({ changed: [{ ...media('attachment'), toolPaths: ['/replacement'] }] })
  f.append(media('orphan-file', 'file'), prose('break'), media('seam-file', 'file'), media('seam-image'))
})

it('repairs local prompt timestamps on append and prepend without sorting file order', () => {
  const stamped = (item: TranscriptItem, second: number) => ({ ...item, ts: `2026-10-06T00:00:0${second}Z` })
  const f = fixture([stamped(prose('reply'), 4)])
  f.append(stamped(user('prompt'), 2))
  f.append(stamped(prose('later'), 5), stamped(user('next'), 3))
  f.prepend(stamped(prose('prefix'), 4))
  f.apply({ changed: [stamped(user('prompt'), 1)] })
})

it('preserves quiet-run boundaries when row kind changes or a call disappears', () => {
  const f = fixture([call('a'), call('b'), call('c'), prose('tail')])
  f.apply({ changed: [call('b', 'same', 'AskUserQuestion')] })
  f.apply({ changed: [call('b')] })
  f.apply({ changed: [], removed: ['b'] })
  f.apply({ changed: [prose('middle')], insertions: [{ id: 'middle', before: 'c' }] })
  f.apply({ changed: [user('a')] })
})

it('keeps an observed row list and unrelated blocks stable across a streamed item', () => {
  const graph = new TranscriptGraph([prose('a'), prose('b')])
  const counts = { list: 0, a: 0, b: 0 }
  const stops = [
    autorun(() => { graph.structuralRows; counts.list++ }),
    autorun(() => { graph.block('a'); counts.a++ }),
    autorun(() => { graph.block('b'); counts.b++ }),
  ]
  try {
    counts.list = counts.a = counts.b = 0
    graph.apply({ changed: [prose('b', 'streamed needle')] })
    expect(counts).toEqual({ list: 0, a: 0, b: 1 })
    expect(graph.matches('needle')).toEqual(['b'])
    expect(graph.snapshot().blocks[1]?.item.text).toBe('streamed needle')
  } finally { for (const stop of stops) stop() }
})

it('discards removed search postings and honours an empty authoritative replacement', () => {
  const graph = new TranscriptGraph([prose('a', 'needle'), prose('b')])
  expect(graph.matches('needle')).toEqual(['a'])
  graph.apply({ changed: [prose('a', 'replacement')] })
  expect(graph.matches('needle')).toEqual([])
  graph.reset([])
  expect(graph.snapshot()).toEqual({ blocks: [], rows: [], search: {
    matches: [], activeMatch: undefined, activeRow: undefined, position: 0, total: 0, filtering: false,
  } })
})

it('retains a quiet run across appends, prefix rekeys and changed title subjects', () => {
  const read = (id: string, path: string) => ({ ...call(id, id), toolInput: JSON.stringify({ file_path: path }) })
  const f = fixture([read('a', '/a'), read('b', '/b'), read('c', '/a')])
  const run = f.graph.run('a')!
  f.append(read('d', '/d'))
  expect(f.graph.run('a')).toBe(run)
  f.prepend(read('prefix', '/prefix'))
  expect(f.graph.run('prefix')).toBe(run)
  expect(f.graph.rowIdForBlock('c')).toBe('prefix')
  f.apply({ changed: [read('b', '/replacement')] })
  f.append(result('done', 'd', 'error: failed'))
  expect(run.failures).toBe(1)
  expect(run.lastBlock?.result).toBe('error: failed')
  f.apply({ changed: [result('done', 'd', 'ok')] })
  expect(run.failures).toBe(0)
})

it('selects the last result and last supplied effects without demanding all progress results', () => {
  const f = fixture([call('call')])
  f.append({ ...result('first', 'same', 'first'), toolEffects: [{ kind: 'unknown', key: 'first' }] }, result('last'))
  f.apply({ changed: [{ ...result('first', 'same', 'updated'), toolEffects: [{ kind: 'unknown', key: 'updated' }] }] })
  expect(f.graph.block('call')?.result).toBe('last')
  expect(f.graph.block('call')?.item.toolEffects?.[0]).toEqual({ kind: 'unknown', key: 'updated' })
  f.apply({ changed: [result('first')] })
  expect(f.graph.block('call')?.item.toolEffects).toBeUndefined()
})
