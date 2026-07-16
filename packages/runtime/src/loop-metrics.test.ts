import { describe, it, expect } from 'vitest'
import { startLoopMetrics } from './loop-metrics'

describe('loop-metrics', () => {
  it('reports the stall once and does not re-spam the stale lifetime max every window', async () => {
    const logs: string[] = []
    const m = startLoopMetrics({
      label: 'test',
      longTickMs: 20,
      sampleMs: 50,
      log: (s) => logs.push(s),
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
    const longTicks = logs.filter((l) => l.includes('long tick'))
    expect(longTicks.length).toBeGreaterThanOrEqual(1)
    // Bound is a spam detector, not an exact count: the buggy version logged the
    // stale max once per window (~8 lines). Shared-vCPU hosts (CPU steal) can add
    // a couple of GENUINE >20ms stalls during the quiet window, so allow slack.
    expect(longTicks.length).toBeLessThanOrEqual(4)
  })
})
