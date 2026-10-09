import { omitGone } from './lookup'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { SETUP_SESSION_SUMMARY_FIELDS } from './settings-schema'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'

const now = Date.parse('2026-10-08T00:00:00Z')
const session = (id: string): RowRecord => ({ kind: 'session', id, value: {
  sessionId: id, agentKind: 'codex', cwd: '/foreign', status: 'exited',
  lastActiveAt: '2020-01-01T00:00:00Z', stoppedAt: '2020-01-01T00:00:00Z',
} } as RowRecord)

function fixture(owner: 'pool' | 'source', rows: RowRecord[]) {
  let index = createColdIndex(SCHEMA, { session: SETUP_SESSION_SUMMARY_FIELDS })
  const load = vi.fn(() => undefined)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined, {
    settings: true, load, schedule: () => () => {}, worklist: 'demand',
    ...(owner === 'source' ? { cold: () => index } : {}),
  })
  const publish = (event: RowSourceEvent) => {
    index.apply(event)
    pool.apply(event)
  }
  publish({ type: 'replace', rows })
  return { pool, load, publish, index: () => index,
    reseed(rows: RowRecord[]) {
      index = createColdIndex(SCHEMA, { session: SETUP_SESSION_SUMMARY_FIELDS })
      index.apply({ type: 'replace', rows })
      pool.apply({ type: 'update', rows: [] })
    },
  }
}

it.each(['pool', 'source'] as const)(
  'keeps demanded setup summaries incremental on %s session add/remove at 1x/4x',
  (owner) => {
    for (const scale of [1, 4]) {
      const rows = Array.from({ length: 128 * scale }, (_, n) => session(`s${n}`))
      const f = fixture(owner, rows)
      const read = vi.fn((id: string) => omitGone(f.pool.row('setupSession', id)))
      const stops = rows.map(row => autorun(() => read(row.id)))
      // Same answers as the old shared-version dependency, including its
      // negative control: an unrelated add/remove wakes every legacy reader.
      const version = observable.box(0), legacyRead = vi.fn((id: string) => {
        version.get()
        return f.index().position('session', id)
      })
      const legacyStops = rows.map(row => autorun(() => legacyRead(row.id)))
      try {
        for (const row of rows) {
          expect(f.pool.sourcePosition('session', row.id)).toBe(legacyRead(row.id))
          expect(omitGone(f.pool.row('setupSession', row.id))).toMatchObject({
            sessionId: row.id, setupOrder: f.index().position('session', row.id),
          })
        }
        for (const value of [session('unrelated'), { kind: 'session', id: 'unrelated', value: undefined } as RowRecord]) {
          read.mockClear(); legacyRead.mockClear()
          runInAction(() => {
            f.publish({ type: 'update', rows: [value] })
            version.set(version.get() + 1)
          })
          expect(legacyRead).toHaveBeenCalledTimes(rows.length)
          expect(read).not.toHaveBeenCalled()
        }
        read.mockClear()
        f.publish({ type: 'update', rows: [{ kind: 'session', id: 's0', value: undefined }] })
        expect(read.mock.calls).toEqual([['s0']])
        read.mockClear()
        f.publish({ type: 'update', rows: [session('s0')] })
        expect(read.mock.calls).toEqual([['s0']])
        expect(omitGone(f.pool.row('setupSession', 's0'))).toMatchObject({ setupOrder: rows.length + 2 })
        expect(f.load).not.toHaveBeenCalled()
      } finally { stops.forEach(stop => stop()); legacyStops.forEach(stop => stop()); f.pool.dispose() }
    }
  },
)

it.each(['pool', 'source'] as const)('notifies only changed %s positions across batches and replacements', (owner) => {
  const a = session('a'), b = session('b'), c = session('c')
  const f = fixture(owner, [a, b, c])
  const values = new Map<string, number | undefined>(), read = vi.fn((id: string) => {
    values.set(id, f.pool.sourcePosition('session', id))
  })
  const stops = ['a', 'b', 'c', 'missing'].map(id => autorun(() => read(id)))
  const check = (ids: string[], expected: (number | undefined)[]) => {
    expect(read.mock.calls.map(([id]) => id).sort()).toEqual(ids.sort())
    expect([...values.values()]).toEqual(expected)
    read.mockClear()
  }
  try {
    check(['a', 'b', 'c', 'missing'], [1, 2, 3, undefined])
    f.publish({ type: 'update', rows: [session('unrelated')] })
    check([], [1, 2, 3, undefined])
    f.publish({ type: 'update', rows: [session('a')] })
    check([], [1, 2, 3, undefined])
    f.publish({ type: 'update', rows: [session('missing')] })
    check(['missing'], [1, 2, 3, 5])
    f.publish({ type: 'update', rows: [
      { kind: 'session', id: 'a', value: undefined }, a,
      session('temporary'), { kind: 'session', id: 'temporary', value: undefined },
    ] })
    check(['a'], [6, 2, 3, 5])
    f.publish({ type: 'replace', rows: [b, a, c] })
    check(['a', 'b', 'missing'], [2, 1, 3, undefined])
    f.publish({ type: 'replace', rows: [b, a, c] })
    check([], [2, 1, 3, undefined])
    f.publish({ type: 'replace', rows: [] })
    check(['a', 'b', 'c'], [undefined, undefined, undefined, undefined])
    f.publish({ type: 'update', rows: [a] })
    check(['a'], [1, undefined, undefined, undefined])
    stops.forEach(stop => stop())
    // A later reader must take the current index value after previous demand
    // was released; imperative reads must not leave an observation behind.
    f.pool.sourcePosition('session', 'b')
    f.publish({ type: 'replace', rows: [b, a] })
    expect(read).not.toHaveBeenCalled()
    const again = autorun(() => read('a'))
    try {
      expect(values.get('a')).toBe(2)
      read.mockClear()
      f.publish({ type: 'update', rows: [{ kind: 'session', id: 'a', value: undefined }] })
      expect(read.mock.calls).toEqual([['a']])
    } finally { again() }
  } finally { stops.forEach(stop => stop()); f.pool.dispose() }
})

it('refreshes observed positions when a source rebuilds its index with the same position version', () => {
  const a = session('a'), b = session('b')
  const f = fixture('source', [a, b])
  const read = vi.fn(() => f.pool.sourcePosition('session', 'a'))
  const stop = autorun(read)
  try {
    const before = f.index().positionVersion
    read.mockClear()
    f.reseed([b, a])
    expect(f.index().positionVersion).toBe(before)
    expect(read).toHaveBeenCalledOnce()
    expect(read.mock.results[0]?.value).toBe(2)
    read.mockClear()
    f.reseed([b, a])
    expect(read).not.toHaveBeenCalled()
  } finally { stop(); f.pool.dispose() }
})

it('releases position demand and notifies existing readers when the pool is disposed', () => {
  const f = fixture('source', [session('a'), session('b')])
  const position = vi.spyOn(f.index(), 'position')
  const first = vi.fn(() => f.pool.sourcePosition('session', 'a'))
  const second = vi.fn(() => f.pool.sourcePosition('session', 'a'))
  const stopFirst = autorun(first), stopSecond = autorun(second)
  try {
    stopFirst()
    second.mockClear()
    f.publish({ type: 'replace', rows: [session('b'), session('a')] })
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(second.mock.results[0]?.value).toBe(2)
    stopSecond()
    position.mockClear()
    f.publish({ type: 'replace', rows: [session('a'), session('b')] })
    expect(position).not.toHaveBeenCalled()
    // Imperative probes return current values but retain no position keys.
    expect(f.pool.sourcePosition('session', 'a')).toBe(1)
    position.mockClear()
    f.publish({ type: 'replace', rows: [session('b'), session('a')] })
    expect(position).not.toHaveBeenCalled()
    const read = vi.fn(() => f.pool.sourcePosition('session', 'a'))
    const stop = autorun(read)
    try {
      read.mockClear()
      f.pool.dispose()
      expect(read).toHaveBeenCalledOnce()
      expect(read.mock.results[0]?.value).toBeUndefined()
      expect(f.pool.sourcePosition('session', 'a')).toBeUndefined()
    } finally { stop() }
  } finally { stopFirst(); stopSecond(); position.mockRestore(); f.pool.dispose() }
})
