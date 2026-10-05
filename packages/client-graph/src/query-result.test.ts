import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { createKeyedAnswer, createKeyedAnswerBuilder, createQueryResult, joinQueryResults } from './query-result'
import { LOADING } from './worklist/rollup'

function fixture(prefix = '') {
  const rows = observable.map<string, { title: string; order: string; privateBody?: string }>(
    [
      [`${prefix}a`, { title: 'A', order: '2' }],
      [`${prefix}b`, { title: 'B', order: '1' }],
    ],
    { deep: false },
  )
  let membership: ((id: string | undefined) => void) | undefined
  const read = vi.fn((id: string) => {
    const row = rows.get(id)
    return row ? { id, title: row.title } : undefined
  })
  const released = vi.fn()
  const result = createQueryResult({
    name: 'test question',
    ids: () => rows.keys(),
    has: (id) => rows.has(id),
    read,
    order: (id) => rows.get(id)?.order ?? id,
    matches: [(value) => value.title.startsWith('A')],
    subscribe: (changed) => {
      membership = changed
      return () => {
        membership = undefined
      }
    },
    released,
  })
  const set = (
    id: string,
    row: { title: string; order: string; privateBody?: string } | undefined,
  ) =>
    runInAction(() => {
      if (row) rows.set(id, row)
      else rows.delete(id)
      membership?.(id)
    })
  return {
    rows,
    result,
    read,
    released,
    set,
    reset: () => runInAction(() => membership?.(undefined)),
  }
}

describe('maintained query answers', () => {
  it('finds strict predecessor and successor across scalar ties, deletion and persistent forks', () => {
    type Value = { id: string; time: number }
    const builder = createKeyedAnswerBuilder<Value>((a, b) => a.time - b.time)
    for (const id of ['c', 'a', 'b']) builder.answer.set(id, '', { id, time: 10 })
    builder.answer.set('older', '', { id: 'older', time: 5 })
    builder.answer.set('newer', '', { id: 'newer', time: 15 })
    const pivot = { id: '', time: 10 }
    expect(builder.answer.before(pivot, '')?.id).toBe('older')
    expect(builder.answer.after(pivot, '')?.id).toBe('a')
    expect(builder.answer.before(pivot, 'b')?.id).toBe('a')
    expect(builder.answer.after(pivot, 'b')?.id).toBe('c')
    const answer = builder.finish(), fork = answer.fork()
    answer.delete('older')
    expect(answer.before(pivot, '')).toBeUndefined()
    expect(fork.before(pivot, '')?.id).toBe('older')
    expect(answer.after({ id: '', time: 20 }, '')).toBeUndefined()
  })
  it.each([256, 1024])('builds initial ordered demand without replaying insertion paths (%i entries)', (count) => {
    let comparisons = 0
    const ids = Array.from({ length: count }, (_, rank) => String(rank).padStart(5, '0'))
    const result = createQueryResult({
      name: 'startup ordered demand', ids: () => ids, has: () => true,
      read: id => ({ id }),
      // Count comparisons through the ordering scalar, without instrumenting
      // the tree implementation. Sorted bootstrap input should take linear work.
      order: id => ({ [Symbol.toPrimitive]() { comparisons++; return id } }) as unknown as string,
      subscribe: () => () => {},
    })
    try {
      const values = result.get()
      expect(values && values !== LOADING ? values.map(value => value.id) : values).toEqual(ids)
      expect(comparisons).toBeGreaterThan(0)
      expect(comparisons).toBeLessThanOrEqual(count * 6)
      console.info('startup initial-order comparisons', JSON.stringify({ count, comparisons }))
    } finally { result.dispose() }
  })

  it('bulk initial answers equal insertion-built trees including ties and match counts', () => {
    for (const ranks of [[], [0], Array.from({ length: 37 }, (_, rank) => rank),
      Array.from({ length: 37 }, (_, rank) => 36 - rank),
      Array.from({ length: 37 }, (_, rank) => (rank * 17) % 37)]) {
      const rows = new Map(ranks.map(rank => {
        const id = String(rank).padStart(3, '0')
        return [id, { id, rank, order: String(rank % 5) }]
      }))
      const inserted = createKeyedAnswer<{ id: string; rank: number; order: string }>()
      const matched = createKeyedAnswer<{ id: string; rank: number; order: string }>()
      for (const [id, row] of rows) {
        inserted.set(id, row.order, row)
        if (row.rank % 2 === 0) matched.set(id, row.order, row)
      }
      const result = createQueryResult({
        name: 'bulk equivalence', ids: () => rows.keys(), has: id => rows.has(id),
        read: id => rows.get(id), order: id => rows.get(id)!.order,
        matches: [row => row.rank % 2 === 0], subscribe: () => () => {},
      })
      const stop = autorun(() => { result.get(); result.firstMatch(0); result.countMatch(0) })
      try {
        expect(result.get()).toEqual(inserted.snapshot())
        expect(result.firstMatch(0)).toEqual(matched.first())
        expect(result.countMatch(0)).toBe(matched.snapshot().length)
      } finally { stop(); result.dispose() }
    }
  })

  it.each([1024, 4096])('replaces startup index revisions in one ordered path (%i entries)', (count) => {
    type Value = { id: string; rank: number; revision: number; deadline: number }
    const compare = vi.fn((a: Value, b: Value) => a.rank - b.rank)
    const answer = createKeyedAnswer(compare, value => value.deadline)
    for (let rank = 0; rank < count; rank++) {
      const id = String(rank).padStart(5, '0')
      answer.set(id, '', { id, rank, revision: 0, deadline: 0 })
    }
    const captured = answer.snapshot(), fork = answer.fork()
    const id = String(count - 1).padStart(5, '0')
    compare.mockClear()
    answer.set(id, '', { id, rank: count - 1, revision: 1, deadline: 99 })
    const comparisons = compare.mock.calls.length
    // Startup scalar indexes repeatedly change bucket/revision values while
    // keeping their order. A remove followed by put traverses this path twice.
    expect(comparisons).toBeLessThanOrEqual(Math.ceil(Math.log2(count)) + 2)
    expect(comparisons).toBeGreaterThan(0)
    expect(answer.get(id)?.revision).toBe(1)
    expect(answer.firstBounded(98, 'above')?.id).toBe(id)
    expect(fork.get(id)?.revision).toBe(0)
    expect(fork.firstBounded(98, 'above')).toBeUndefined()
    expect(captured.at(-1)?.revision).toBe(0)
    expect(answer.snapshot().map(value => value.rank)).toEqual(Array.from({ length: count }, (_, rank) => rank))
    console.info('startup stable-key comparisons', JSON.stringify({ count, comparisons }))
  })

  it('reorders changed scalar keys and preserves snapshots when a matching value changes', () => {
    const f = fixture()
    const lists: { id: string; title: string }[][] = [], witnesses: unknown[] = [], counts: unknown[] = []
    const stops = [autorun(() => {
      const value = f.result.get()
      if (value && value !== LOADING) lists.push(value)
    }), autorun(() => witnesses.push(f.result.firstMatch(0))), autorun(() => counts.push(f.result.countMatch(0)))]
    try {
      f.set('a', { title: 'Another title', order: '2' })
      expect(lists.at(-1)?.map(value => value.title)).toEqual(['B', 'Another title'])
      expect(lists[0]?.map(value => value.title)).toEqual(['B', 'A'])
      expect(witnesses.at(-1)).toEqual({ id: 'a', title: 'Another title' })
      expect(counts).toEqual([1])
      f.set('a', { title: 'Changed membership', order: '2' })
      expect(witnesses.at(-1)).toBeUndefined()
      expect(counts).toEqual([1, 0])
      f.set('a', { title: 'Again first', order: '0' })
      expect(lists.at(-1)?.map(value => value.id)).toEqual(['a', 'b'])
      expect(witnesses.at(-1)).toEqual({ id: 'a', title: 'Again first' })
      expect(counts).toEqual([1, 0, 1])
    } finally { for (const stop of stops) stop() }
  })

  it('publishes incremental counts when a non-witness changes and releases closed demand', () => {
    const f = fixture(), counts: unknown[] = [], witnesses: unknown[] = []
    const count = autorun(() => counts.push(f.result.countMatch(0)))
    const witness = autorun(() => witnesses.push(f.result.firstMatch(0)))
    try {
      expect(counts).toEqual([1])
      f.set('c', { title: 'Another', order: '3' })
      expect(counts).toEqual([1, 2])
      expect(witnesses).toHaveLength(1)
      f.set('c', { title: 'Also matches', order: '3' })
      expect(counts).toEqual([1, 2])
      f.set('c', undefined)
      expect(counts).toEqual([1, 2, 1])
      expect(witnesses).toHaveLength(1)
      f.reset()
      expect(counts.at(-1)).toBe(1)
      count(); witness()
      f.read.mockClear()
      f.set('a', { title: 'Changed while closed', order: '2' })
      expect(f.read).not.toHaveBeenCalled()
      expect(f.released).toHaveBeenCalledOnce()
    } finally { count(); witness() }
  })
  it('joins disjoint rosters in global order and preserves captured answers and native array behavior', () => {
    const left = fixture(), right = fixture('x')
    const seen: { id: string; title: string }[][] = []
    let inputs: { id: string; title: string }[][] = []
    const stop = autorun(() => {
      const a = left.result.get(), b = right.result.get()
      if (!a || a === LOADING || !b || b === LOADING) return
      inputs = [a, b]
      seen.push(joinQueryResults(inputs))
    })
    const parity = () => {
      const expected = [...left.rows, ...right.rows]
        .sort(([a, av], [b, bv]) => av.order.localeCompare(bv.order) || a.localeCompare(b))
        .map(([id, row]) => ({ id, title: row.title }))
      expect(seen.at(-1)).toEqual(expected)
    }
    try {
      expect(seen[0]?.map(row => row.id)).toEqual(['b', 'xb', 'a', 'xa'])
      expect(Array.isArray(seen[0])).toBe(true)
      expect(Object.keys(seen[0]!)).toEqual(['0', '1', '2', '3'])
      expect(seen[0]?.at(-1)?.id).toBe('xa')
      expect(seen[0]?.findIndex(row => row.id === 'a')).toBe(2)
      expect(JSON.parse(JSON.stringify(seen[0]))).toEqual([...seen[0]!])
      left.read.mockClear(); right.read.mockClear()
      joinQueryResults(inputs)
      expect(left.read).not.toHaveBeenCalled()
      expect(right.read).not.toHaveBeenCalled()
      left.set('a', { title: 'Changed', order: '0' })
      right.set('xb', undefined)
      right.set('xc', { title: 'New', order: '1' })
      parity()
      expect(seen[0]?.map(row => [row.id, row.title])).toEqual([
        ['b', 'B'], ['xb', 'B'], ['a', 'A'], ['xa', 'A'],
      ])
      left.set('b', undefined)
      right.set('xa', undefined)
      parity()
      const before = inputs.map(input => [...input])
      const current = seen.at(-1)!
      current.sort((a, b) => b.id.localeCompare(a.id))
      current.splice(0, 1, { id: 'local', title: 'Detached edit' })
      expect(current.map(row => row.id)).toEqual(['local', 'a'])
      expect(inputs.map(input => [...input])).toEqual(before)
      expect(seen[0]).toHaveLength(4)
      // A caller-mutated array is no longer an ordered tree snapshot.
      inputs[0]!.push({ id: 'local', title: 'Detached edit' })
      expect(() => joinQueryResults(inputs)).toThrow('Expected an ordered query snapshot')
    } finally { stop() }
    expect(left.released).toHaveBeenCalledTimes(1)
    expect(right.released).toHaveBeenCalledTimes(1)
  })

  it('updates only the changed answer, preserves old snapshots and ignores undeclared fields', () => {
    const f = fixture()
    const seen: { id: string; title: string }[][] = []
    const stop = autorun(() => {
      const value = f.result.get()
      if (value !== LOADING && value) seen.push(value)
    })
    try {
      expect(Array.isArray(seen[0])).toBe(true)
      expect(JSON.stringify(seen[0])).toBe('[{"id":"b","title":"B"},{"id":"a","title":"A"}]')
      expect(Object.keys(seen[0]!)).toEqual(['0', '1'])
      f.read.mockClear()
      f.set('a', { title: 'A', order: '2', privateBody: 'unrelated' })
      expect(f.read.mock.calls).toEqual([['a']])
      expect(seen).toHaveLength(1)
      f.set('a', { title: 'Changed', order: '0' })
      expect(seen[1]?.map((value) => value.id)).toEqual(['a', 'b'])
      expect(seen[0]?.map((value) => value.title)).toEqual(['B', 'A'])
      f.set('c', { title: 'C', order: '3' })
      f.set('b', undefined)
      expect([...seen.at(-1)!]).toEqual([
        { id: 'a', title: 'Changed' },
        { id: 'c', title: 'C' },
      ])
      expect(seen[1]?.map((value) => value.id)).toEqual(['a', 'b'])
      const copy = seen.at(-1)!
      copy.sort((a, b) => b.id.localeCompare(a.id))
      expect(copy.map((value) => value.id)).toEqual(['c', 'a'])
      expect(seen[0]?.map((value) => value.title)).toEqual(['B', 'A'])
    } finally {
      stop()
    }
    expect(f.released).toHaveBeenCalledTimes(1)
    f.read.mockClear()
    f.set('a', { title: 'Unobserved', order: '0' })
    expect(f.read).not.toHaveBeenCalled()
  })

  it('keeps existential witnesses observed when the full result releases and resets a slice', () => {
    const f = fixture()
    let match: unknown, list: unknown
    const stopList = autorun(() => {
      list = f.result.get()
    })
    const stopMatch = autorun(() => {
      match = f.result.firstMatch(0)
    })
    try {
      stopList()
      expect(f.released).not.toHaveBeenCalled()
      f.set('a', { title: 'Another', order: '2' })
      expect(match).toEqual({ id: 'a', title: 'Another' })
      f.set('a', { title: 'No longer matches', order: '2' })
      expect(match).toBeUndefined()
      f.reset()
      expect(f.released).not.toHaveBeenCalled()
      expect(list).toEqual([
        { id: 'b', title: 'B' },
        { id: 'a', title: 'A' },
      ])
    } finally {
      stopMatch()
    }
    expect(f.released).toHaveBeenCalledTimes(1)
  })

  it('matches an independent sorted rebuild through insertions, removals and reordering', () => {
    const f = fixture()
    let current: unknown
    const stop = autorun(() => {
      current = f.result.get()
    })
    try {
      for (let step = 0; step < 160; step++) {
        const id = String((step * 37) % 43)
        f.set(id, step % 5 === 0 ? undefined : { title: `Title ${step}`, order: String(step % 11) })
        const expected = [...f.rows]
          .sort(([a, av], [b, bv]) => av.order.localeCompare(bv.order) || a.localeCompare(b))
          .map(([id, value]) => ({ id, title: value.title }))
        expect(current).toEqual(expected)
      }
    } finally {
      stop()
    }
  })

  it('publishes witness removal and resolved LOADING when a replaced question becomes empty', () => {
    let ids = ['a']
    let reset: ((id: string | undefined) => void) | undefined
    const flags = observable.box({ asking: true }, { deep: false })
    const result = createQueryResult({
      name: 'replaced witness question',
      ids: () => ids,
      has: (id) => ids.includes(id),
      read: (id) => {
        const value = flags.get()
        return id === 'pending' ? LOADING : { id, ...value }
      },
      matches: [(value) => value.asking],
      subscribe: (changed) => {
        reset = changed
        return () => { reset = undefined }
      },
    })
    let current: unknown
    const stop = autorun(() => { current = result.firstMatch(0) })
    const replace = (next: string[]) => runInAction(() => {
      ids = next
      reset?.(undefined)
    })
    try {
      expect(current).toEqual({ id: 'a', asking: true })
      replace([])
      expect(current).toBeUndefined()
      replace(['pending'])
      expect(current).toBe(LOADING)
      replace([])
      expect(current).toBeUndefined()
    } finally {
      stop()
    }
  })

  it('reports LOADING until every demanded answer resolves, including witnesses', () => {
    const rows = observable.map<string, number>([
      ['a', 1],
      ['b', 0],
    ])
    const result = createQueryResult({
      name: 'loading question',
      ids: () => rows.keys(),
      has: (id) => rows.has(id),
      read: (id) => (rows.get(id) === 0 ? LOADING : rows.get(id)),
      matches: [(value) => value > 0],
      subscribe: () => () => {},
    })
    let current: unknown, match: unknown
    const stop = autorun(() => {
      current = result.get()
      match = result.firstMatch(0)
    })
    try {
      expect(current).toBe(LOADING)
      expect(match).toBe(LOADING)
      runInAction(() => rows.set('b', 2))
      expect(current).toEqual([1, 2])
      expect(match).toBe(1)
    } finally {
      stop()
    }
  })
})


describe('unpublished keyed answer construction', () => {
  it('matches incremental ordering, ties, duplicates and scalar bounds before persistent edits', () => {
    type Value = { id: string; rank: number; deadline: number }
    for (const custom of [false, true]) for (const ranks of [[], [1], [0, 1, 2, 3], [3, 2, 1, 0],
      Array.from({ length: 37 }, (_, n) => n * 17 % 5)]) {
      const compare = custom ? (a: Value, b: Value) => a.rank - b.rank : undefined
      const point = (value: Value) => value.deadline
      const builder = createKeyedAnswerBuilder(compare, point), inserted = createKeyedAnswer(compare, point)
      const put = (id: string, rank: number) => {
        const value = { id, rank, deadline: rank % 3 }
        builder.answer.set(id, String(rank), value); inserted.set(id, String(rank), value)
      }
      ranks.forEach((rank, n) => put(`s${n}`, rank))
      put('duplicate', 9); put('duplicate', 1)
      builder.answer.delete('s1'); inserted.delete('s1')
      expect(builder.answer.has('duplicate')).toBe(true)
      expect(builder.answer.get('duplicate')).toEqual(inserted.get('duplicate'))
      const answer = builder.finish(), snapshot = answer.snapshot(), fork = answer.fork()
      expect(snapshot).toEqual(inserted.snapshot())
      for (const value of snapshot) {
        expect(answer.after(value, value.id)).toEqual(inserted.after(value, value.id))
        for (const side of ['atMost', 'above'] as const)
          expect(answer.firstBounded(1, side, value, value.id)).toEqual(inserted.firstBounded(1, side, value, value.id))
      }
      const changed = { id: 'duplicate', rank: -1, deadline: 100 }
      builder.answer.set('duplicate', '-1', changed); inserted.set('duplicate', '-1', changed)
      expect(answer.snapshot()).toEqual(inserted.snapshot())
      expect(fork.snapshot()).toEqual(snapshot)
      fork.delete('duplicate')
      expect(answer.has('duplicate')).toBe(true)
      expect(snapshot).toContainEqual({ id: 'duplicate', rank: 1, deadline: 1 })
      expect(builder.finish()).toBe(answer)
    }
  })

  it('finishes at the first ordered read and preserves previously returned snapshots', () => {
    expect(createKeyedAnswerBuilder<number>().finish().snapshot()).toEqual([])
    const builder = createKeyedAnswerBuilder<number>()
    builder.answer.set('b', 'b', 2)
    const before = builder.answer.snapshot()
    builder.answer.set('a', 'a', 1)
    expect(before).toEqual([2])
    expect(builder.finish().snapshot()).toEqual([1, 2])
    builder.answer.delete('b')
    expect(builder.finish().snapshot()).toEqual([1])
  })
})
