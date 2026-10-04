import { autorun, observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { createQueryResult, joinQueryResults } from './query-result'
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
