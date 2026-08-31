import { describe, expect, it } from 'vitest'
import { readinessRecheckDelayMs } from './readiness'

describe('readinessRecheckDelayMs', () => {
  it('backs off quickly at first, then settles on a steady 30s cadence', () => {
    expect(readinessRecheckDelayMs(0)).toBe(2_000)
    expect(readinessRecheckDelayMs(1)).toBe(5_000)
    expect(readinessRecheckDelayMs(2)).toBe(10_000)
    expect(readinessRecheckDelayMs(3)).toBe(30_000)
    // Steady state: a client parked for hours never polls faster than 30s.
    expect(readinessRecheckDelayMs(100)).toBe(30_000)
  })

  it('never returns a zero or negative delay', () => {
    for (let tick = 0; tick < 10; tick++) {
      expect(readinessRecheckDelayMs(tick)).toBeGreaterThan(0)
    }
  })
})
