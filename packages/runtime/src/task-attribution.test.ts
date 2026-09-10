import { afterEach, describe, expect, it, vi } from 'vitest'
import { addLoopAccounting, clearLoopAccounting } from './loop-accounting'
import {
  attributeTasks,
  formatTopTasks,
  recordTask,
  resetTaskAttribution,
  taskAttributionCoverage,
  taskAttributionSnapshot,
  taskAttributionTotals,
} from './task-attribution'

/**
 * The instrument has to be able to SAY SOMETHING before its silence means
 * anything — every test here asserts a positive measurement, not just an absence
 * (POD-1931; the whole reason this module exists is that the previous
 * instruments could only confirm the costs they already knew about).
 */
describe('task attribution', () => {
  afterEach(() => resetTaskAttribution())

  it('is a no-op when disabled — the whole cost model', () => {
    const before = globalThis.setTimeout
    const restore = attributeTasks(false)
    expect(globalThis.setTimeout).toBe(before)
    restore()
    expect(globalThis.setTimeout).toBe(before)
  })

  it('times a setTimeout callback and attributes it to its name', async () => {
    const restore = attributeTasks(true)
    try {
      await new Promise<void>((resolve) => {
        setTimeout(function slowSweep() {
          const until = performance.now() + 12
          while (performance.now() < until) {
            /* burn a measurable slice */
          }
          resolve()
        }, 0)
      })
    } finally {
      restore()
    }
    const entry = [...taskAttributionSnapshot()].find(([label]) => label.includes('slowSweep'))
    expect(entry).toBeDefined()
    expect(entry?.[1].count).toBe(1)
    expect(entry?.[1].wallMs).toBeGreaterThan(5)
    expect(entry?.[1].maxMs).toBeGreaterThan(5)
  })

  it('times a microtask, which is where coalesced work hops', async () => {
    const restore = attributeTasks(true)
    try {
      await new Promise<void>((resolve) => {
        queueMicrotask(function coalescedFlush() {
          resolve()
        })
      })
    } finally {
      restore()
    }
    expect([...taskAttributionSnapshot()].some(([l]) => l.includes('coalescedFlush'))).toBe(true)
  })

  it('counts every fire of one interval under a single label', () => {
    resetTaskAttribution()
    for (let i = 0; i < 3; i++) recordTask('setInterval(1000) sweep', 4)
    const cost = taskAttributionSnapshot().get('setInterval(1000) sweep')
    expect(cost).toEqual({ count: 3, wallMs: 12, maxMs: 4 })
  })

  it('restores every scheduler it patched', () => {
    const before = {
      setTimeout: globalThis.setTimeout,
      setInterval: globalThis.setInterval,
      setImmediate: globalThis.setImmediate,
      queueMicrotask: globalThis.queueMicrotask,
    }
    const restore = attributeTasks(true)
    expect(globalThis.setTimeout).not.toBe(before.setTimeout)
    restore()
    expect(globalThis.setTimeout).toBe(before.setTimeout)
    expect(globalThis.setInterval).toBe(before.setInterval)
    expect(globalThis.setImmediate).toBe(before.setImmediate)
    expect(globalThis.queueMicrotask).toBe(before.queueMicrotask)
  })

  it('reports COVERAGE, so the top task is read against what it explains', () => {
    resetTaskAttribution()
    recordTask('setInterval(5000) janitor', 30)
    // 30ms of measured work inside a 300ms stall explains a tenth of it. Saying
    // so is the point: the previous instruments could not, and the largest named
    // thing was mistaken for the cause.
    expect(taskAttributionCoverage(300)).toBeCloseTo(0.1, 5)
    expect(taskAttributionCoverage(0)).toBe(0)
  })

  it('orders the log line by summed wall time, not by count', () => {
    resetTaskAttribution()
    recordTask('setInterval(1000) chatty', 1)
    recordTask('setInterval(1000) chatty', 1)
    recordTask('setInterval(1000) chatty', 1)
    recordTask('setTimeout(0) heavy', 40)
    expect(formatTopTasks(1)).toContain('heavy')
  })

  it('keeps lifetime totals across a window reset', () => {
    resetTaskAttribution()
    recordTask('setInterval(1000) sweep', 5)
    resetTaskAttribution()
    expect(taskAttributionSnapshot().size).toBe(0)
    expect(taskAttributionTotals().get('setInterval(1000) sweep')?.count).toBeGreaterThan(0)
  })

  it('hands a non-function handler to the original, verbatim', () => {
    // A string handler has no identity to key on, so it is passed through
    // untouched rather than measured. "Untouched" is the contract being
    // asserted: whatever the unpatched scheduler does with it — this runtime
    // rejects it — the patched one must do the same, so instrumenting a process
    // cannot change how it fails.
    const unpatched = (): unknown => setTimeout('' as unknown as () => void, 0)
    let unpatchedError: string | undefined
    try {
      unpatched()
    } catch (err) {
      unpatchedError = (err as Error).message
    }

    const restore = attributeTasks(true)
    let patchedError: string | undefined
    try {
      unpatched()
    } catch (err) {
      patchedError = (err as Error).message
    } finally {
      restore()
    }
    expect(patchedError).toBe(unpatchedError)
  })
})

/**
 * Which COST BUCKET a recorded region lands in (§6.1).
 *
 * The routing lives here, on the label, rather than at each seam, because every
 * one of them already funnels through `recordTask` — `measureTask` and the
 * scheduler patch both do. That is also what makes the count right: a region is
 * attributed EXACTLY ONCE. Attributing `timers` in `recordTask` *and* a mapped
 * bucket in `measureTask` would have billed every WebSocket frame to two buckets
 * and pushed coverage over 1 with nothing nested to explain it.
 */
describe('bucket routing', () => {
  function capture(): [string, number][] {
    const calls: [string, number][] = []
    addLoopAccounting({ attribute: (bucket, wallMs) => calls.push([bucket, wallMs]) })
    return calls
  }

  afterEach(() => {
    resetTaskAttribution()
    clearLoopAccounting()
  })

  it('bills a scheduled callback to timers and each seam label to its own bucket', () => {
    const calls = capture()
    recordTask('setInterval(1000) sweep', 4)
    recordTask('setTimeout(0) flush', 3)
    recordTask('microtask hop', 1)
    recordTask('ws.client.parse', 7)
    recordTask('ws.message.client', 5)
    recordTask('ws.message.daemon', 9)
    recordTask('ws.message.machine', 8)
    recordTask('worker.janitor', 2)
    recordTask('controlParse', 11)
    recordTask('controlDispatch(input)', 12)
    recordTask('frames', 6)
    recordTask('tailBatch(12)', 13)
    recordTask('publishConv(3)', 14)
    expect(calls).toEqual([
      ['timers', 4],
      ['timers', 3],
      ['timers', 1],
      ['ws.client', 7],
      ['ws.client', 5],
      ['ws.daemon', 9],
      ['ws.daemon', 8],
      ['worker', 2],
      ['control', 11],
      ['control', 12],
      ['frames', 6],
      ['tails', 13],
      ['worker', 14],
    ])
  })

  it('bills an unrecognised label to NO bucket rather than guessing one', () => {
    const calls = capture()
    // `ws.message.unknown` is a real label — ws-server falls back to it for a
    // frame whose kind it cannot read. A bucket it lands in by default would be
    // a measurement of the fallback, not of the work.
    recordTask('ws.message.unknown', 40)
    recordTask('somethingNobodyMapped', 40)
    expect(calls).toEqual([])
  })

  it('bills a timed seam region exactly once', async () => {
    // `measureTask` reads the level at IMPORT and a test run resolves `off`
    // (POD-3827), so the level is STATED and the module re-imported.
    // `loop-accounting` comes along because the fresh graph carries its own
    // registry, and a spy registered in the old one would never be called.
    const prior = process.env.PODIUM_LOOP_PROFILE
    process.env.PODIUM_LOOP_PROFILE = 'attribution'
    vi.resetModules()
    try {
      const accounting = await import('./loop-accounting')
      const { measureTask: subject } = await import('./task-attribution')
      const calls: string[] = []
      accounting.addLoopAccounting({ attribute: (bucket) => calls.push(bucket) })
      subject('ws.client.ping', () => undefined)
      // ONE bucket, not two: routing lives in `recordTask`, which this funnels
      // through, so the region is never billed as both `ws.client` and `timers`.
      expect(calls).toEqual(['ws.client'])
      accounting.clearLoopAccounting()
    } finally {
      if (prior === undefined) delete process.env.PODIUM_LOOP_PROFILE
      else process.env.PODIUM_LOOP_PROFILE = prior
    }
  })

  it('feeds EVERY registered handle — all-in-one hosts both components in one PID', () => {
    // apps/cli `all-in-one` sets roles { server: true, daemon: true }, so two
    // handles exist at once, each writing its own minute file. With a single slot
    // the second registration captured every seam and the other component's
    // buckets came out empty — no error, no log line, just a coverage figure
    // that read as a missing seam. There is ONE event loop in that PID, so the
    // cost is on the loop both records describe and both must receive it.
    const server: string[] = []
    const daemon: string[] = []
    const dropServer = addLoopAccounting({ attribute: (bucket) => server.push(bucket) })
    const dropDaemon = addLoopAccounting({ attribute: (bucket) => daemon.push(bucket) })
    recordTask('ws.client.parse', 5)
    expect(server).toEqual(['ws.client'])
    expect(daemon).toEqual(['ws.client'])
    // And one component shutting down must not take the other's accounting with
    // it: `all-in-one` stops its two hosts one at a time.
    dropServer()
    recordTask('tailBatch(1)', 2)
    expect(server).toEqual(['ws.client'])
    expect(daemon).toEqual(['ws.client', 'tails'])
    dropDaemon()
    recordTask('frames', 1)
    expect(daemon).toEqual(['ws.client', 'tails'])
  })

  it('records without a handle — the process may not have started accounting yet', () => {
    clearLoopAccounting()
    expect(() => recordTask('setInterval(1000) early', 4)).not.toThrow()
    expect(taskAttributionSnapshot().get('setInterval(1000) early')?.count).toBe(1)
  })
})
