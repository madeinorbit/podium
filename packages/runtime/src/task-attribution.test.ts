import { afterEach, describe, expect, it } from 'vitest'
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
