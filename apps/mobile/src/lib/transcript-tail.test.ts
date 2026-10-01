import { describe, expect, it } from 'vitest'
import { measureAtTail, tailOffset } from './transcript-tail'

describe('measured tail geometry', () => {
  it('allows fractional rounding at the actual bottom, not a proximity band', () => {
    expect(measureAtTail(1000, 800, 1802)).toBe(true)
    expect(measureAtTail(1000, 800, 1803)).toBe(false)
    expect(measureAtTail(1000, 800, 1840)).toBe(false)
  })
  it('includes the composer inset in the tail target', () => {
    expect(tailOffset(2525 + 120, 735)).toBe(1910)
  })
  it('overshoots safely before the viewport is measured', () => {
    expect(tailOffset(2525, 0)).toBe(2525)
  })
  it('never asks for a negative offset when content fits', () => {
    expect(tailOffset(400, 735)).toBe(0)
  })
})
