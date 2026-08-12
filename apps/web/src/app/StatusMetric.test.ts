import { describe, expect, it } from 'vitest'
import { tooltipShiftPx } from './StatusMetric'

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
