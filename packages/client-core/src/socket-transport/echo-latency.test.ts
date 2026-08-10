import { describe, expect, it } from 'vitest'
import { EchoLatencyTracker } from './echo-latency'

function enabledTracker(): EchoLatencyTracker {
  const tracker = new EchoLatencyTracker()
  tracker.setEnabled(true)
  return tracker
}

describe('EchoLatencyTracker', () => {
  it('is inert and empty until explicitly enabled', () => {
    const tracker = new EchoLatencyTracker()
    tracker.onInput(1_000)
    tracker.onOutput(1_010)
    tracker.onPaint(1_020)

    expect(tracker.stats(1_030)).toEqual({
      enabled: false,
      count: 0,
      p50: null,
      p90: null,
      max: null,
      lastMs: null,
      toFrame: { count: 0, p50: null, p90: null, max: null, lastMs: null },
      frameToPaint: { count: 0, p50: null, p90: null, max: null, lastMs: null },
      last: null,
    })
  })

  it('closes only after output arrival and browser paint', () => {
    const tracker = enabledTracker()
    tracker.onInput(1_000)
    tracker.onOutput(1_042)
    expect(tracker.awaitingPaint()).toBe(true)
    expect(tracker.stats(1_050).count).toBe(0)

    tracker.onPaint(1_058)
    expect(tracker.stats(1_060)).toMatchObject({
      enabled: true,
      count: 1,
      p50: 58,
      lastMs: 58,
      toFrame: { p50: 42, lastMs: 42 },
      frameToPaint: { p50: 16, lastMs: 16 },
      last: { toFrameMs: 42, frameToPaintMs: 16, totalMs: 58 },
    })
  })

  it('does not mistake a render before output for the echo', () => {
    const tracker = enabledTracker()
    tracker.onInput(1_000)
    expect(tracker.awaitingPaint()).toBe(false)
    tracker.onPaint(1_010)
    expect(tracker.stats(1_020).count).toBe(0)
  })

  it('one rendered frame closes a whole typed burst with per-input timings', () => {
    const tracker = enabledTracker()
    tracker.onInput(1_000)
    tracker.onInput(1_010)
    tracker.onInput(1_020)
    tracker.onOutput(1_050)
    tracker.onPaint(1_066)

    const stats = tracker.stats(1_070)
    expect(stats.count).toBe(3)
    expect(stats.p50).toBe(56) // totals [66, 56, 46]
    expect(stats.toFrame.p50).toBe(40)
    expect(stats.frameToPaint.p50).toBe(16)
  })

  it('keeps input after a frame pending for a later frame', () => {
    const tracker = enabledTracker()
    tracker.onInput(1_000)
    tracker.onOutput(1_020)
    tracker.onInput(1_025)
    tracker.onPaint(1_036)
    expect(tracker.stats(1_040).count).toBe(1)

    tracker.onOutput(1_050)
    tracker.onPaint(1_066)
    expect(tracker.stats(1_070).count).toBe(2)
    expect(tracker.stats(1_070).last).toEqual({
      toFrameMs: 25,
      frameToPaintMs: 16,
      totalMs: 41,
    })
  })

  it('discards stale unpainted input', () => {
    const tracker = enabledTracker()
    tracker.onInput(1_000)
    tracker.onOutput(4_000)
    tracker.onPaint(4_016)
    expect(tracker.stats(4_020).count).toBe(0)
  })

  it('ages samples out of the 30 second window', () => {
    const tracker = enabledTracker()
    tracker.onInput(1_000)
    tracker.onOutput(1_040)
    tracker.onPaint(1_050)
    expect(tracker.stats(2_000).count).toBe(1)
    expect(tracker.stats(31_051).count).toBe(0)
  })

  it('clears retained and pending timings when disabled', () => {
    const tracker = enabledTracker()
    tracker.onInput(1_000)
    tracker.onOutput(1_020)
    tracker.onPaint(1_030)
    tracker.onInput(1_040)
    tracker.setEnabled(false)
    tracker.setEnabled(true)
    tracker.onOutput(1_050)
    tracker.onPaint(1_060)
    expect(tracker.stats(1_070).count).toBe(0)
  })
})
