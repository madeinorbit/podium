import { describe, expect, it } from 'vitest'
import { atTail, measureAtTail } from './transcript-tail'

describe('atTail', () => {
  it('opens at the tail even while the settling layout measures away from it', () => {
    // The defect (POD-724): markdown and images grow the content after the
    // first paint, so the reading during the opening frames says "mid-history".
    expect(atTail({ operatorMoved: false, measuredAtTail: false })).toBe(true)
  })

  it('hands the answer to the measurement once the operator has scrolled', () => {
    expect(atTail({ operatorMoved: true, measuredAtTail: false })).toBe(false)
    expect(atTail({ operatorMoved: true, measuredAtTail: true })).toBe(true)
  })
})

describe('measureAtTail', () => {
  it('counts a viewport within the slack as the bottom', () => {
    expect(measureAtTail(1000, 800, 1840)).toBe(true)
    expect(measureAtTail(1000, 800, 1849)).toBe(false)
  })
})
