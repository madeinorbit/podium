// Keystroke→echo latency tracker (#11): pending inputs are closed by the first
// subsequent output frame, stale inputs are discarded, stats are a sliding window.
import { describe, expect, it } from 'vitest'
import { EchoLatencyTracker } from './echo-latency'

describe('EchoLatencyTracker', () => {
  it('starts empty', () => {
    const t = new EchoLatencyTracker()
    expect(t.stats(1000)).toEqual({ count: 0, p50: null, p90: null, max: null, lastMs: null })
  })

  it('closes a single input with the next output frame', () => {
    const t = new EchoLatencyTracker()
    t.onInput(1000)
    t.onOutput(1042)
    const s = t.stats(1050)
    expect(s.count).toBe(1)
    expect(s.p50).toBe(42)
    expect(s.p90).toBe(42)
    expect(s.max).toBe(42)
    expect(s.lastMs).toBe(42)
  })

  it('one frame closes a whole typed burst, each with its own latency', () => {
    const t = new EchoLatencyTracker()
    t.onInput(1000)
    t.onInput(1010)
    t.onInput(1020)
    t.onOutput(1050)
    const s = t.stats(1060)
    expect(s.count).toBe(3)
    expect(s.max).toBe(50)
    expect(s.p50).toBe(40) // sorted [30, 40, 50]
  })

  it('output with nothing pending records no sample', () => {
    const t = new EchoLatencyTracker()
    t.onOutput(1000)
    t.onOutput(1016)
    expect(t.stats(1020).count).toBe(0)
  })

  it('an input never echoed within the timeout is discarded, not sampled', () => {
    const t = new EchoLatencyTracker()
    t.onInput(1000)
    t.onOutput(4000) // 3s later — beyond PENDING_TIMEOUT_MS
    expect(t.stats(4010).count).toBe(0)
  })

  it('a stale input does not leak into the next fresh measurement', () => {
    const t = new EchoLatencyTracker()
    t.onInput(1000) // swallowed key, never echoed
    t.onInput(10_000)
    t.onOutput(10_040)
    const s = t.stats(10_050)
    expect(s.count).toBe(1)
    expect(s.lastMs).toBe(40)
  })

  it('samples age out of the 30s window', () => {
    const t = new EchoLatencyTracker()
    t.onInput(1000)
    t.onOutput(1050)
    expect(t.stats(2000).count).toBe(1)
    expect(t.stats(1050 + 30_001).count).toBe(0)
  })

  it('percentiles use nearest-rank over the sorted window', () => {
    const t = new EchoLatencyTracker()
    // 10 samples: 10, 20, …, 100 (each input closed by its own frame)
    for (let i = 1; i <= 10; i++) {
      const base = 1000 + i * 200
      t.onInput(base)
      t.onOutput(base + i * 10)
    }
    const s = t.stats(1000 + 10 * 200 + 200)
    expect(s.count).toBe(10)
    expect(s.p50).toBe(50)
    expect(s.p90).toBe(90)
    expect(s.max).toBe(100)
  })

  it('caps the pending queue instead of growing unboundedly', () => {
    const t = new EchoLatencyTracker()
    for (let i = 0; i < 200; i++) t.onInput(1000 + i)
    t.onOutput(1300)
    expect(t.stats(1310).count).toBe(64) // PENDING_CAP
  })
})
