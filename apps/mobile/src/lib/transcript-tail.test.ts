import { describe, expect, it } from 'vitest'
import {
  atTail,
  measureAtTail,
  newestJump,
  shouldFollowContentGrowth,
  tailOffset,
} from './transcript-tail'

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

describe('shouldFollowContentGrowth', () => {
  it('follows only a taller content box while the feed is pinning', () => {
    expect(shouldFollowContentGrowth({ previousHeight: 400, nextHeight: 520, pinning: true })).toBe(
      true,
    )
  })

  it('ignores a no-op or shrink so scrollToEnd cannot loop', () => {
    expect(shouldFollowContentGrowth({ previousHeight: 520, nextHeight: 520, pinning: true })).toBe(
      false,
    )
    expect(shouldFollowContentGrowth({ previousHeight: 520, nextHeight: 500, pinning: true })).toBe(
      false,
    )
  })

  it('does not yank a reader who has left the tail', () => {
    expect(
      shouldFollowContentGrowth({ previousHeight: 400, nextHeight: 800, pinning: false }),
    ).toBe(false)
  })
})

describe('tailOffset', () => {
  it('lands the newest row on the bottom edge', () => {
    expect(tailOffset(2525, 735)).toBe(1790)
  })

  it('overshoots rather than under-scrolls before the viewport is measured', () => {
    // The measured live case (POD-1251): the phone opened a hibernated
    // transcript 1790px short of its newest message because the list's own
    // "end" was 0. An unmeasured viewport must not be able to produce that
    // again — the scroll views clamp an overshoot, they do not clamp a 0.
    expect(tailOffset(2525, 0)).toBe(2525)
  })

  it('never asks for a negative offset when the content fits', () => {
    expect(tailOffset(400, 735)).toBe(0)
  })
})

describe('newestJump', () => {
  it('targets the tracked content height, which carries the composer inset padding', () => {
    // The regression (2026-08-28): scrollToEnd aimed at the virtualized list's
    // own approximate end, which omits the content container's paddingBottom —
    // the room the feed pays for the floating composer — so "Newest" stopped a
    // composer-height above the last message. The jump must use the height the
    // list reported through onContentSizeChange, padding included.
    const contentWithComposerInset = 2525 + 120
    expect(newestJump(contentWithComposerInset, 735, false)).toEqual({
      offset: 2645 - 735,
      animated: true,
    })
  })

  it('honours Reduce Motion by jumping without travel', () => {
    expect(newestJump(2000, 700, true)).toEqual({ offset: 1300, animated: false })
  })

  it('overshoots safely before the viewport has been measured', () => {
    expect(newestJump(2000, 0, false).offset).toBe(2000)
  })
})
