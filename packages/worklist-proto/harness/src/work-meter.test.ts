/**
 * POD-4746 — the outside work counter (`work-meter.ts`), both directions:
 * each kind of walk counts its elements, derivation bodies count, work on the
 * other side does not, the side follows awaits and timers, and every patch is
 * gone after the window.
 */

import { autorun, computed, ObservableMap, ObservableSet, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { ARM_CODE, insideArm, insideReader, measureWork, outsideArm } from './work-meter'
import { MobxPool } from '@podium/client-graph/pool'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `i${i}`)

describe('elements', () => {
  it('counts every element a walk visits', async () => {
    const array = ids(10)
    const set = new Set(array)
    const map = new Map(array.map((id) => [id, id]))
    const record = Object.fromEntries(map)
    const walks: [string, () => unknown, number][] = [
      [
        'for…of array',
        () => {
          for (const _ of array) void _
        },
        10,
      ],
      ['spread', () => [...array], 10],
      ['map callback', () => array.map((id) => id), 10],
      ['find stops early', () => array.find((id) => id === 'i2'), 3],
      ['includes', () => array.includes('i9'), 10],
      ['reduce', () => array.reduce((sum, id) => sum + id.length, 0), 10],
      ['slice then sort: the same ten', () => array.slice().sort(), 10],
      [
        'Set for…of',
        () => {
          for (const _ of set) void _
        },
        10,
      ],
      ['Array.from(Set)', () => Array.from(set), 10],
      ['Map values', () => [...map.values()], 10],
      ['Map forEach', () => map.forEach(() => {}), 10],
      ['Object.keys', () => Object.keys(record), 10],
    ]
    for (const [name, walk, expected] of walks) {
      const { work } = await measureWork(async () => insideArm(walk))
      expect(work.elements, name).toBe(expected)
    }
  })

  it('counts an element once however many walks visit it; visits keep the repeats', async () => {
    const family = ids(12)
    const numbers = [3, 3, 3, 3]
    const { work } = await measureWork(async () =>
      insideArm(() => {
        void [...family]
        void family.filter((id) => id !== 'i0')
        void family.slice().sort()
        void numbers.map((n) => n) // equal numbers are distinct positions
      }),
    )
    expect(work.elements).toBe(12 + 4)
    expect(work.visits).toBe(12 + 12 + 12 + 12 + 4)
  })

  it('counts a row’s MobX nodes as the row (`<Class>@<id>.<part>`), any other node as itself', async () => {
    // POD-4792: MobX's fan-out to one changed row's parts is one row touched.
    const nodes = [
      { name_: 'IssueModel@i1.attention' },
      { name_: 'IssueModel@i1.phase' },
      { name_: 'GroupNode@g1.rowIds' },
      { name_: 'pool.seats' },
      { name_: 'observerPoolRow' },
      'i1',
    ]
    const { work } = await measureWork(async () => insideArm(() => nodes.forEach(() => {})))
    // i1 (its two parts and the id), g1, and the two unnamed-for-a-row nodes.
    expect(work.elements).toBe(4)
    expect(work.visits).toBe(6)
  })

  it('counts MobX observable collections through the native ones they are built on', async () => {
    const set = new ObservableSet(ids(40))
    const map = new ObservableMap(ids(40).map((id): [string, string] => [id, id]))
    const array = observable.array(ids(40))
    const walk = async (fn: () => unknown) => (await measureWork(async () => insideArm(fn))).work
    expect((await walk(() => [...set])).elements).toBe(40)
    expect((await walk(() => [...map.keys()])).elements).toBe(40)
    expect((await walk(() => array.filter(() => true))).elements).toBe(40)
  })

  it('counts only the arm’s side, and the side follows awaits and timers', async () => {
    const array = ids(100)
    const { work } = await measureWork(async () => {
      void [...array] // the window itself is not the arm: 0
      await insideArm(async () => {
        void array.slice(0, 5) // the arm: 5 (of the 100 below)
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            void array.map((id) => id) // a timer the arm scheduled: 100
            resolve()
          }, 1),
        )
        await outsideArm(async () => {
          void [...array] // outside, called by the arm: 0
          await new Promise<void>((resolve) =>
            setTimeout(() => {
              void [...array] // a timer the outside scheduled: 0
              resolve()
            }, 1),
          )
        })
      })
    })
    expect(work.visits).toBe(105)
    expect(work.elements).toBe(100)
    expect(work.elementsBy).toEqual({ [ARM_CODE]: 100 })
  })

  it('counts nothing outside a window, and restores every patch', async () => {
    const before = [
      Array.prototype[Symbol.iterator],
      Set.prototype.forEach,
      Map.prototype.keys,
      Object.keys,
    ]
    await measureWork(async () => undefined)
    expect([
      Array.prototype[Symbol.iterator],
      Set.prototype.forEach,
      Map.prototype.keys,
      Object.keys,
    ]).toEqual(before)
    await expect(measureWork(async () => measureWork(async () => undefined))).rejects.toThrow(
      /already running/,
    )
  })
})

describe('derivations', () => {
  it('counts computed bodies and reaction bodies that run, not cached reads, and runs them as the arm', async () => {
    const box = observable.box(1)
    const list = ids(30)
    const double = computed(
      () => {
        void [...list] // a walk inside a derivation is the arm's, wherever it is called from
        return box.get() * 2
      },
      { name: 'node17.double' },
    )
    let seen = 0
    const dispose = autorun(() => {
      seen = double.get()
    })
    try {
      const change = await measureWork(async () => {
        runInAction(() => box.set(2))
      })
      // The computed re-ran once, the autorun once; the computed's walk counts,
      // as the computed's.
      expect(change.work.derivations).toBe(2)
      expect(change.work.elements).toBe(30)
      expect(change.work.elementsBy).toEqual({ 'node#.double': 30 })
      expect(seen).toBe(4)
      const idle = await measureWork(async () => insideArm(() => double.get()))
      expect(idle.work).toEqual({ derivations: 0, derivationsBy: {}, elements: 0, elementsBy: {}, visits: 0 })
    } finally {
      dispose()
    }
  })
})

describe('pool reader windows', () => {
  it('counts resident, summary, repeated and absent reads plus untracked app consumer bodies', async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'i1', value: {
      id: 'i1', seq: 1, title: 'One', stage: 'planning', repoPath: '/synthetic', createdAt: '', updatedAt: '',
    } }] })
    const original = pool.row
    try {
      const measured = await measureWork(async () => {
        insideReader('menu', () => {
          pool.row('issue', 'i1')
          pool.row('issue', 'i1', 'summary')
          pool.row('issue', 'missing')
        })
        await insideReader('after-await', async () => {
          await Promise.resolve()
          pool.row('issue', 'i1')
        })
      }, { pool })
      expect(measured.work.rows).toBe(4)
      expect(measured.work.rowsBy).toEqual({ 'consumer:menu': 3, 'consumer:after-await': 1 })
      expect(measured.work.derivationsBy).toEqual({ 'consumer:menu': 1, 'consumer:after-await': 1 })
      expect(pool.row).toBe(original)
      expect(Object.hasOwn(pool, 'row')).toBe(false)
      await expect(measureWork(async () => { pool.row('issue', 'i1'); throw new Error('plant') }, { pool })).rejects.toThrow('plant')
      expect(pool.row).toBe(original)
    } finally { pool.dispose() }
  })

  it('counts a computed per consumer and excludes warm-up/idle reads from the next window', async () => {
    const input = observable.box(0)
    const first = computed(() => input.get() * 2, { name: 'double' })
    const stop = autorun(() => insideReader('panel', () => first.get()), { name: 'consumer:panel' })
    try {
      const changed = await measureWork(async () => { runInAction(() => input.set(1)) })
      expect(changed.work.derivationsBy['consumer:panel/double']).toBe(1)
      const idle = await measureWork(async () => { first.get() })
      expect(idle.work.derivations).toBe(0)
    } finally { stop() }
  })
})
