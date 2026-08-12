/**
 * When the chat is AT ITS TAIL — the rule the transcript's bottom-pinning obeys
 * (POD-724).
 *
 * The feed is chronological, not inverted, so "open at the newest message" is
 * something the list has to DO rather than something its layout gives it. It
 * used to be decided by measurement alone: pin while the viewport sits within a
 * hair of the content bottom, scroll to the end whenever the content grows.
 * That is right in the steady state and wrong at exactly the moment it matters
 * most — on open. Content height climbs for several frames while markdown,
 * images and tool rows lay out, and each of the settling scrolls React Native
 * reports along the way measures as "not at the bottom", so the pin was routinely
 * dropped before the last row existed and the chat opened mid-history.
 *
 * The fix is to separate a MEASUREMENT from an INTENT. Until the operator has
 * moved the feed with their own finger, the intent is the tail and no reading
 * may overrule it; once they have, the measurement is the whole answer, because
 * a reader who scrolled up must never be yanked back down.
 */

export interface TailReading {
  /** A real user gesture has moved this feed (drag, momentum, touch, wheel). */
  operatorMoved: boolean
  /** The viewport is within {@link TAIL_SLACK} of the content bottom. */
  measuredAtTail: boolean
}

/** How close to the bottom still counts as the bottom. */
export const TAIL_SLACK = 48

export function measureAtTail(
  contentOffsetY: number,
  layoutHeight: number,
  contentHeight: number,
  slack: number = TAIL_SLACK,
): boolean {
  return contentOffsetY + layoutHeight >= contentHeight - slack
}

/**
 * Whether the feed should be treated as sitting at its newest row — and so
 * whether growth re-anchors to the end and the jump-to-newest pill stays away.
 */
export function atTail(reading: TailReading): boolean {
  return reading.operatorMoved ? reading.measuredAtTail : true
}
