import { addSink, resetLogging, type LogRecord } from '@podium/logger'
import { afterEach, describe, expect, it } from 'vitest'
import { startLoopMetrics } from './loop-metrics'

afterEach(() => {
  resetLogging()
})

describe('loop-metrics', () => {
  it('reports the stall once and does not re-spam the stale lifetime max every window', async () => {
    const stalls: number[] = []
    const m = startLoopMetrics({
      longTickMs: 20,
      sampleMs: 50,
      onLongTick: (ms) => stalls.push(ms),
    })
    // ONE stall: block the loop ~80ms so a long tick is recorded...
    const end = Date.now() + 80
    while (Date.now() < end) {
      /* busy */
    }
    // ...then stay quiet for ~8 sample windows. The buggy version logged the
    // stale histogram max once per window (~8 lines); the probe path logs the
    // stall once and is silent while the loop is healthy.
    await new Promise((r) => setTimeout(r, 400))
    const snap = m.snapshot()
    m.stop()
    expect(snap.max).toBeGreaterThan(20)
    expect(stalls.length).toBeGreaterThanOrEqual(1)
    // Bound is a spam detector, not an exact count: the buggy version logged the
    // stale max once per window (~8 lines). Shared-vCPU hosts (CPU steal) can add
    // a couple of GENUINE >20ms stalls during the quiet window, so allow slack.
    expect(stalls.length).toBeLessThanOrEqual(4)
  })

  it('writes no record of its own — the onLongTick caller owns the record (POD-1932)', async () => {
    // The probe used to ALSO log a prose line next to the caller's structured
    // record, so every stall on the live server was written twice, ~1ms apart.
    // Detection here is the probe firing; the sink must stay empty regardless.
    const records: LogRecord[] = []
    addSink({ name: 'collector', minLevel: 'trace', write: (r) => records.push(r) })
    const stalls: number[] = []
    const m = startLoopMetrics({
      longTickMs: 20,
      sampleMs: 50,
      onLongTick: (ms) => stalls.push(ms),
    })
    const end = Date.now() + 80
    while (Date.now() < end) {
      /* busy */
    }
    await new Promise((r) => setTimeout(r, 100))
    m.stop()
    expect(stalls.length).toBeGreaterThanOrEqual(1)
    expect(records).toEqual([])
  })
})
