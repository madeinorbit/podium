import { omitGone } from '@podium/client-graph/lookup'
/**
 * POD-4746 — the outside work counter (`work-meter.ts`), both directions:
 * each kind of walk counts its elements, derivation bodies count, work on the
 * other side does not, the side follows awaits and timers, and every patch is
 * gone after the window.
 */

import { EntityModel, MODEL_CLASSES } from '@podium/client-graph/models'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { lazy } from '@podium/mobx-helpers'
import {
  autorun,
  compareStructural,
  computed,
  ObservableMap,
  ObservableSet,
  observable,
  runInAction,
} from 'mobx'
import { describe, expect, it } from 'vitest'
import { assertScreenWork, SCREEN_ACTIONS, screenWorkVerdicts } from './screen-work-ratios'
import {
  ARM_CODE,
  countedStructuralEqual,
  insideArm,
  insideReader,
  measureWork,
  outsideArm,
  type WorkCounts,
} from './work-meter'

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
      expect(idle.work).toEqual({
        derivations: 0,
        derivationsBy: {},
        elements: 0,
        elementsBy: {},
        visits: 0,
      })
    } finally {
      dispose()
    }
  })
})

describe('pool reader windows', () => {
  const cells = (work: WorkCounts) => SCREEN_ACTIONS.map((action) => ({
    action,
    neighbourhood: ['issue:drawn'],
    work,
  }))

  it.each(Object.entries(MODEL_CLASSES))(
    'keeps %s fields flat when their first demanding view changes',
    async (_entity, Model) => {
      async function measured(first: string, named: boolean) {
        const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
        const model = new Model('guard-seat', pool)
        const fields = ['exists', 'lastActivity', 'phase'].map((field) => computed(
          () => omitGone(pool.row(model.entity, model.id)),
          { name: named ? `${Model.name}@guard-seat.${field}` : field, context: model },
        ))
        let stop: (() => void) | undefined
        try {
          return (await measureWork(async () => {
            stop = autorun(() => {
              insideReader(first, () => fields.forEach((field) => field.get()))
              insideReader(first === 'mobile-inbox' ? 'mission.pane' : 'mobile-inbox',
                () => fields.forEach((field) => field.get()))
            }, { name: 'demand' })
          }, { pool })).work
        } finally {
          stop?.()
          pool.dispose()
        }
      }
      for (const named of [true, false]) {
        const first = await measured('mobile-inbox', named)
        const second = await measured('mission.pane', named)
        const keys = ['exists', 'lastActivity', 'phase'].map((field) => `${Model.name}@guard-seat.${field}`)
        for (const key of keys) {
          expect(first.rowsBy![key]).toBe(1)
          expect(second.rowsBy![key]).toBe(1)
          expect(first.derivationsBy[key]).toBe(1)
          expect(second.derivationsBy[key]).toBe(1)
        }
        const verdicts = screenWorkVerdicts(cells(first), cells(second))
          .filter((verdict) => keys.includes(verdict.reader) && verdict.kind !== 'elements')
        expect(verdicts).toHaveLength(SCREEN_ACTIONS.length * keys.length * 2)
        expect(() => assertScreenWork(verdicts)).not.toThrow()
        expect(Object.keys(second.rowsBy!).some((key) => key.includes('/' + Model.name))).toBe(false)
        expect(second.rows).toBe(first.rows)
        expect(second.derivations).toBe(first.derivations)
        expect(second.elements).toBe(first.elements)
      }
    },
  )

  class MeterEntity extends EntityModel {
    constructor(readonly items: readonly string[], pool: MobxPool) {
      super('issue', 'guard-seat', pool)
    }
    @lazy get rowReads() {
      for (let index = 0; index < this.items.length; index++) this.host.row('issue', this.items[index]!)
      return this.items.length
    }
  }

  class MeterViewModel {
    readonly id = 'guard-seat'
    constructor(readonly items: readonly string[], readonly pool: MobxPool) {}
    @lazy get rowReads() {
      for (let index = 0; index < this.items.length; index++) omitGone(this.pool.row('issue', this.items[index]!))
      return this.items.length
    }
  }

  async function measuredLazy(scale: number, entity: boolean, first: string) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const items = ids(scale)
    const model = entity ? new MeterEntity(items, pool) : new MeterViewModel(items, pool)
    let stop: (() => void) | undefined
    try {
      return (await measureWork(async () => {
        stop = autorun(() => {
          insideReader(first, () => model.rowReads)
          insideReader('second-view', () => model.rowReads)
          // A much larger flat counter cannot drown out the planted field.
          insideReader('expensive-constant', () => {
            for (let index = 0; index < 1000; index++) omitGone(pool.row('issue', 'constant'))
          })
        }, { name: 'demand' })
      }, { pool })).work
    } finally {
      stop?.()
      pool.dispose()
    }
  }

  it('rejects an extra row read per item in an actual shared lazy field, even when the first view changes', async () => {
    const first = await measuredLazy(1, true, 'mobile-inbox')
    const flat = await measuredLazy(1, true, 'mission.pane')
    const second = await measuredLazy(4, true, 'mission.pane')
    const key = 'MeterEntity@guard-seat.rowReads'
    expect(first.rowsBy![key]).toBe(1)
    expect(flat.rowsBy![key]).toBe(1)
    expect(second.rowsBy![key]).toBe(4)
    const fieldVerdicts = (work: WorkCounts) => screenWorkVerdicts(cells(first), cells(work))
      .filter((verdict) => verdict.reader === key)
    expect(() => assertScreenWork(fieldVerdicts(flat))).not.toThrow()
    expect(fieldVerdicts(second).filter((verdict) => !verdict.passed && verdict.kind === 'rows')).toEqual(
      SCREEN_ACTIONS.map((action) => ({
        action, kind: 'rows', reader: key, at1x: 1, at4x: 4,
        neighbourhood1x: 1, neighbourhood4x: 1, passed: false,
      })),
    )
    expect(() => assertScreenWork(fieldVerdicts(second))).toThrow(/MeterEntity@guard-seat.rowReads/)
    expect(second.rowsBy!['consumer:expensive-constant']).toBe(1000)
  })

  it('still charges growth in a view-owned lazy computed to that view', async () => {
    const first = await measuredLazy(1, false, 'mission.pane')
    const second = await measuredLazy(4, false, 'mission.pane')
    const key = 'consumer:mission.pane/MeterViewModel@guard-seat.rowReads'
    expect(first.rowsBy![key]).toBe(1)
    expect(second.rowsBy![key]).toBe(4)
    expect(second.derivationsBy[key]).toBe(1)
    expect(second.rowsBy!['MeterViewModel@guard-seat.rowReads']).toBeUndefined()
    expect(() => assertScreenWork(screenWorkVerdicts(cells(first), cells(second)))).toThrow(
      /consumer:mission.pane\/MeterViewModel@guard-seat.rowReads/,
    )
  })

  it('recognizes explicit entity-field names without a scope but keeps nested view work on its consumer', async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const view = computed(() => omitGone(pool.row('issue', 'view')), { name: 'MissionDeckModel@guard-seat.row' })
    const field = computed(() => view.get(), { name: 'SessionModel@guard-seat.exists' })
    let stop: (() => void) | undefined
    try {
      const { work } = await measureWork(async () => {
        await insideReader('mission.pane', async () => {
          await Promise.resolve()
          stop = autorun(() => field.get(), { name: 'demand' })
        })
      }, { pool })
      expect(work.derivationsBy['SessionModel@guard-seat.exists']).toBe(1)
      expect(work.rowsBy!['consumer:mission.pane/MissionDeckModel@guard-seat.row']).toBe(1)
    } finally {
      stop?.()
      pool.dispose()
    }
  })

  it('catches the app projection walking pre-cached equal arrays, with no row reads or extra derivations', async () => {
    async function measured(scale: number) {
      const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
      const tick = observable.box(false)
      // Repeated cached values prove that visited slots, not only identities,
      // must count when the app compares equal vectors.
      const first = Object.freeze({
        ids: Object.freeze(Array.from({ length: scale }, () => 'same')),
      })
      const second = Object.freeze({
        ids: Object.freeze(Array.from({ length: scale }, () => 'same')),
      })
      const projection = createPoolProjection(
        pool,
        () => insideReader('cached', () => (tick.get() ? second : first)),
        {
          name: 'consumer:cached',
          equals: (a, b) => insideReader('cached.compare', () => countedStructuralEqual(a, b)),
        },
      )
      const initial = projection.getSnapshot()
      let wakes = 0
      const stop = projection.subscribe(() => {
        wakes++
      })
      try {
        const { work } = await measureWork(async () => runInAction(() => tick.set(true)), { pool })
        expect(projection.getSnapshot()).toBe(initial)
        expect(wakes).toBe(0)
        expect(work.rows).toBe(0)
        return work
      } finally {
        stop()
        pool.dispose()
      }
    }
    const first = await measured(1),
      second = await measured(4)
    expect(second.derivations).toBe(first.derivations)
    expect(second.elementsBy['consumer:cached.compare']).toBeGreaterThan(
      first.elementsBy['consumer:cached.compare']!,
    )
    const cells = (work: typeof first) =>
      SCREEN_ACTIONS.map((action) => ({
        action,
        neighbourhood: ['issue:drawn'],
        work,
      }))
    expect(() => assertScreenWork(screenWorkVerdicts(cells(first), cells(second)))).toThrow(
      /cached.compare/,
    )
  })

  it('preserves MobX comparison decisions for frozen values, native collections, aliases and cycles', async () => {
    const child = Object.freeze({ id: 'shared' })
    const cycleA: { self?: unknown } = {},
      cycleB: { self?: unknown } = {}
    cycleA.self = cycleA
    cycleB.self = cycleB
    const pairs: [unknown, unknown][] = [
      [
        Object.freeze({ rows: Object.freeze([child, child]) }),
        Object.freeze({ rows: Object.freeze([child, child]) }),
      ],
      [
        new Map([['rows', Object.freeze(['a', 'b'])]]),
        new Map([['rows', Object.freeze(['a', 'b'])]]),
      ],
      [new Set(['a', 'b']), new Set(['a', 'b'])],
      [new Date(1), new Date(1)],
      [cycleA, cycleB],
      [Object.freeze(['a', 'b']), Object.freeze(['a', 'c'])],
      [{ value: 1 }, { value: 2 }],
      [Object.assign(Object.create(null), { value: 1 }), { value: 1 }],
      [null, undefined],
    ]
    for (const [a, b] of pairs) {
      const expected = compareStructural(a, b)
      const { value } = await measureWork(async () =>
        insideReader('comparison', () => countedStructuralEqual(a, b)),
      )
      expect(value).toBe(expected)
    }
  })

  it('rejects a planted real pool scan through row, derivation and collection counters', async () => {
    async function measured(scale: number, scan: boolean) {
      const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
      const rows = ids(scale)
      pool.apply({
        type: 'replace',
        rows: rows.map((id) => ({
          kind: 'issue',
          id,
          value: {
            id,
            seq: 1,
            title: id,
            stage: 'planning',
            repoPath: '/synthetic',
            createdAt: '1970-01-01T00:00:00.000Z',
            updatedAt: '1970-01-01T00:00:00.000Z',
          },
        })),
      })
      const views = rows.map((id) =>
        computed(() => omitGone(pool.row('issue', id)), { name: 'rowProjection' }),
      )
      try {
        return (
          await measureWork(
            async () =>
              insideReader('panel', () =>
                scan ? views.map((view) => view.get()) : views[0]!.get(),
              ),
            { pool },
          )
        ).work
      } finally {
        pool.dispose()
      }
    }
    const cells = (work: Awaited<ReturnType<typeof measured>>) =>
      SCREEN_ACTIONS.map((action) => ({
        action,
        neighbourhood: ['issue:drawn'],
        work,
      }))
    const bounded = screenWorkVerdicts(
      cells(await measured(1, false)),
      cells(await measured(4, false)),
    )
    expect(() => assertScreenWork(bounded)).not.toThrow()
    const planted = screenWorkVerdicts(
      cells(await measured(1, true)),
      cells(await measured(4, true)),
    )
    for (const kind of ['rows', 'derivations', 'elements'] as const) {
      expect(
        planted.some((value) => value.kind === kind && !value.passed),
        kind,
      ).toBe(true)
    }
    expect(() => assertScreenWork(planted)).toThrow(/consumer:panel/)
  })
  it('counts resident, summary, repeated and absent reads plus untracked app consumer bodies', async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    pool.apply({
      type: 'replace',
      rows: [
        {
          kind: 'issue',
          id: 'i1',
          value: {
            id: 'i1',
            seq: 1,
            title: 'One',
            stage: 'planning',
            repoPath: '/synthetic',
            createdAt: '',
            updatedAt: '',
          },
        },
      ],
    })
    const original = pool.row
    try {
      const measured = await measureWork(
        async () => {
          insideReader('menu', () => {
            omitGone(pool.row('issue', 'i1'))
            omitGone(pool.row('issue', 'i1', 'summary'))
            omitGone(pool.row('issue', 'missing'))
          })
          await insideReader('after-await', async () => {
            await Promise.resolve()
            omitGone(pool.row('issue', 'i1'))
          })
        },
        { pool },
      )
      expect(measured.work.rows).toBe(4)
      expect(measured.work.rowsBy).toEqual({ 'consumer:menu': 3, 'consumer:after-await': 1 })
      expect(measured.work.derivationsBy).toEqual({ 'consumer:menu': 1, 'consumer:after-await': 1 })
      expect(pool.row).toBe(original)
      expect(Object.hasOwn(pool, 'row')).toBe(false)
      await expect(
        measureWork(
          async () => {
            omitGone(pool.row('issue', 'i1'))
            throw new Error('plant')
          },
          { pool },
        ),
      ).rejects.toThrow('plant')
      expect(pool.row).toBe(original)
    } finally {
      pool.dispose()
    }
  })

  it('counts a computed per consumer and excludes warm-up/idle reads from the next window', async () => {
    const input = observable.box(0)
    const first = computed(() => input.get() * 2, { name: 'double' })
    const stop = autorun(() => insideReader('panel', () => first.get()), { name: 'consumer:panel' })
    try {
      const changed = await measureWork(async () => {
        runInAction(() => input.set(1))
      })
      expect(changed.work.derivationsBy['consumer:panel/double']).toBe(1)
      const idle = await measureWork(async () => {
        first.get()
      })
      expect(idle.work.derivations).toBe(0)
    } finally {
      stop()
    }
  })
})
