import { describe, expect, it } from 'vitest'
import { bucketEndMs, tooltipShiftPx } from './StatusMetric'

describe('bucketEndMs', () => {
  const bucket = { startMs: 10_000, value: 3 }

  it('uses the metric bucket duration for historical boundaries', () => {
    expect(bucketEndMs(bucket, 0, 24, 30 * 60 * 1_000)).toBe(1_810_000)
    expect(bucketEndMs(bucket, 0, 12, 60 * 60 * 1_000)).toBe(3_610_000)
  })

  it('keeps the latest bucket anchored to now', () => {
    expect(bucketEndMs(bucket, 23, 24, 30 * 60 * 1_000)).toBeNull()
  })
})

describe('tooltipShiftPx', () => {
  it('leaves a fitting tooltip alone', () => {
    expect(tooltipShiftPx({ left: 40, right: 280 }, 1000)).toBe(0)
  })

  it('shifts right when the card would cross the left edge', () => {
    expect(tooltipShiftPx({ left: -20, right: 206 }, 1000)).toBe(28)
  })

  it('shifts left when the card would cross the right edge', () => {
    expect(tooltipShiftPx({ left: 900, right: 1126 }, 1000)).toBe(-134)
  })

  it('prefers the left pad when the card is wider than the viewport', () => {
    expect(tooltipShiftPx({ left: -40, right: 1040 }, 1000, 8)).toBe(48)
  })
})
