import { afterEach, describe, expect, it } from 'vitest'
import {
  bindSidebarPerf,
  observeSidebarPerfBinding,
  createSidebarPerf,
  recordSidebarDerivation,
  reportSidebarCheck,
  reportSidebarPool,
  sidebarPerfFor,
} from './sidebar-perf'
import { recordSliceDerivation, recordStoreRowRedraw, storeStats } from './store-stats'

afterEach(() => {
  storeStats.enable(false)
  storeStats.reset()
})

describe('passive sidebar report', () => {
  it('stays at zero through five minutes of reads; reports a timer redraw and expires it at 60 s', () => {
    let at = 0
    const perf = createSidebarPerf(() => at)
    for (at = 0; at <= 300_000; at += 1000)
      expect(perf.read().idle).toEqual({ rows: 0, derivations: 0, mainThreadMs: 0 })
    perf.record({ rows: 1, derivations: 1, start: at, end: at + 2 })
    expect(perf.read().idle).toEqual({ rows: 1, derivations: 1, mainThreadMs: 2 })
    at += 59_999
    expect(perf.read().idle.rows).toBe(1)
    at++
    expect(perf.read().idle.rows).toBe(0)
  })

  it('keeps input/update work out of idle and preserves the last incoming update after 60 s', () => {
    let at = 0
    const perf = createSidebarPerf(() => at)
    const input = perf.beginInput()
    perf.record({ rows: 2 })
    at = 10
    perf.endInput(input, 0, true)
    const update = perf.beginUpdate(['issues', 'sessions'])
    perf.record({ rows: 3, derivations: 2, start: 10, end: 14 })
    at = 15
    perf.endUpdate(update)
    expect(perf.read().idle.rows).toBe(0)
    at = 75_000
    expect(perf.read().lastUpdate).toMatchObject({
      changed: ['issues', 'sessions'],
      pending: false,
      work: { rows: 3, derivations: 2, mainThreadMs: 4 },
    })
    perf.record({ rows: 1 })
    expect(perf.read().idle.rows).toBe(1)
  })

  it('unions overlapping measured CPU instead of double-counting nested work', () => {
    const perf = createSidebarPerf(() => 20)
    perf.record({ derivations: 1, start: 1, end: 5 })
    perf.record({ rows: 1, start: 0, end: 10 })
    perf.record({ rows: 1, start: 12, end: 14 })
    expect(perf.read().idle).toEqual({ rows: 2, derivations: 1, mainThreadMs: 12 })
  })

  it('computes session percentiles and ignores duplicate paint callbacks and non-sidebar input', () => {
    let at = 0
    const perf = createSidebarPerf(() => at)
    for (const duration of [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) {
      const token = perf.beginInput()
      at += duration
      perf.endInput(token, at - duration, true)
      perf.endInput(token, 0, true)
    }
    perf.endInput(perf.beginInput(), 0, false)
    expect(perf.read().input).toEqual({ lastMs: 100, p50: 5, p95: 100, count: 10 })
  })

  it('accounts checker work separately, and a new principal clears every report', () => {
    const perf = createSidebarPerf(() => 100)
    const end = perf.beginCheck()
    perf.record({ rows: 1, derivations: 4, start: 1, end: 8 })
    end()
    end()
    perf.pool(true, 23)
    perf.check({ state: 'different', differences: 1, checkedAt: 100 })
    expect(perf.read().idle).toEqual({ rows: 0, derivations: 0, mainThreadMs: 0 })
    expect(perf.read().checkWork).toEqual({ rows: 1, derivations: 4, mainThreadMs: 7 })
    perf.record({ rows: 2 })
    expect(perf.read().idle.rows).toBe(2)
    perf.reset()
    expect(perf.read()).toMatchObject({
      pool: { connected: false, rows: null },
      check: { state: 'off', differences: 0 },
      idle: { rows: 0 },
      input: { count: 0 },
    })
  })

  it('bounds retained work and refuses a complete zero after counter overflow', () => {
    const perf = createSidebarPerf(() => 0)
    for (let i = 0; i < 20_001; i++) perf.record({ rows: 1 })
    expect(perf.read().complete).toBe(false)
    expect(perf.read().idle.rows).toBe(20_000)
  })

  it('scopes legacy row/derive pulses to the open panel and actual store owner', () => {
    const owner = {},
      other = {}
    const perf = createSidebarPerf(() => 100)
    const stop = bindSidebarPerf(owner, perf)
    try {
      recordSliceDerivation(owner, 'worklist')
      expect(perf.read().idle.derivations).toBe(0)
      storeStats.enable()
      recordSliceDerivation(other, 'worklist')
      recordSliceDerivation(owner, 'worklist')
      recordStoreRowRedraw(owner, 1, 3)
      expect(perf.read().idle).toEqual({ rows: 1, derivations: 1, mainThreadMs: 2 })
      storeStats.enable(false)
      recordStoreRowRedraw(owner, 3, 6)
      expect(perf.read().idle.rows).toBe(1)
    } finally {
      stop()
    }
    expect(sidebarPerfFor(owner)).toBeNull()
  })

  it('starts and stops outside meters on panel open, replacement, close and listener disposal', () => {
    const owner = {},
      other = {}
    const perf = createSidebarPerf()
    const next = createSidebarPerf()
    const events: Array<typeof perf | null> = []
    const stop = observeSidebarPerfBinding(owner, (binding) => events.push(binding))
    const close = bindSidebarPerf(owner, perf)
    const closeNext = bindSidebarPerf(other, next)
    close() // an old cleanup must not stop the current binding
    expect(sidebarPerfFor(other)).toBe(next)
    expect(events).toEqual([null, perf, null])
    closeNext()
    const reopen = bindSidebarPerf(owner, perf)
    stop()
    reopen()
    expect(events).toEqual([null, perf, null, perf, null])
  })

  it('accepts pool and S5 scalar reports without retaining or reading a pool', () => {
    const owner = {},
      other = {}
    reportSidebarPool(owner, 14)
    reportSidebarCheck(owner, { state: 'match', differences: 0, checkedAt: 10 })
    const perf = createSidebarPerf(() => 100)
    const stop = bindSidebarPerf(owner, perf)
    try {
      recordSidebarDerivation(other, 1, 4)
      recordSidebarDerivation(owner, 1, 4)
      expect(perf.read()).toMatchObject({
        pool: { rows: 14, connected: true },
        check: { state: 'match' },
        idle: { derivations: 1, mainThreadMs: 3 },
      })
      reportSidebarPool(owner, 15)
      expect(perf.read().pool.rows).toBe(15)
    } finally {
      stop()
    }
  })
})
