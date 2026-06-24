import { describe, it, expect } from 'vitest'
import { startLoopMetrics } from './loop-metrics.js'

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
})
