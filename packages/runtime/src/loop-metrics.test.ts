import { describe, it, expect } from 'vitest'
import { startLoopMetrics } from './loop-metrics'

describe('loop-metrics', () => {
  it('reports percentiles and warns on a long tick', async () => {
    const logs: string[] = []
    const m = startLoopMetrics({ label: 'test', longTickMs: 20, sampleMs: 50, log: (s) => logs.push(s) })
    // Block the loop ~80ms so a long tick is recorded.
    const end = Date.now() + 80
    while (Date.now() < end) {/* busy */}
    await new Promise((r) => setTimeout(r, 120))
    const snap = m.snapshot()
    m.stop()
    expect(snap.max).toBeGreaterThan(20)
    expect(logs.some((l) => l.includes('long tick'))).toBe(true)
  })

  it('does not re-report the stale lifetime max every window (no spam after one stall)', async () => {
    const logs: string[] = []
    const m = startLoopMetrics({ label: 'test', longTickMs: 20, sampleMs: 50, log: (s) => logs.push(s) })
    // ONE stall...
    const end = Date.now() + 80
    while (Date.now() < end) {/* busy */}
    // ...then stay quiet for ~8 sample windows. The buggy version logged the
    // stale histogram max once per window (~8 lines); the probe path logs the
    // stall once and is silent while the loop is healthy.
    await new Promise((r) => setTimeout(r, 400))
    m.stop()
    const longTicks = logs.filter((l) => l.includes('long tick'))
    expect(longTicks.length).toBeGreaterThanOrEqual(1)
    expect(longTicks.length).toBeLessThanOrEqual(2)
  })
})
