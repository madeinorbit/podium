import { describe, expect, it } from 'vitest'
import { keyboardOverlap } from './useKeyboardHeight'

const frame = (screenY: number, height: number) =>
  ({ endCoordinates: { screenY, height, screenX: 0, width: 393 } }) as never

describe('keyboardOverlap', () => {
  it('reports the intrusion while the keyboard is up', () => {
    // 852pt window, keyboard top at 506 → 346pt of intrusion.
    expect(keyboardOverlap(852, frame(506, 346))).toBe(346)
  })

  it('reports zero for a keyboard parked at the window bottom', () => {
    expect(keyboardOverlap(852, frame(852, 346))).toBe(0)
  })

  it('never exceeds the keyboard frame height mid-slide', () => {
    // A will-change-frame tick can report the resting position early; the
    // overlap is capped by the keyboard's own height.
    expect(keyboardOverlap(852, frame(400, 346))).toBe(346)
  })
})
