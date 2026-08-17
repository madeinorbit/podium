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

/**
 * Whether growth should re-anchor the feed to its newest row.
 *
 * Only follow an INCREASE. `scrollToEnd` on react-native-web often reports the
 * same (or a rounded) content height back through `onContentSizeChange`; treating
 * that echo as another pin produces an unbounded layout loop that freezes the
 * phone UI for minutes.
 */
export function shouldFollowContentGrowth(args: {
  previousHeight: number
  nextHeight: number
  pinning: boolean
}): boolean {
  if (!args.pinning) return false
  return args.nextHeight > args.previousHeight
}

/**
 * Where the newest row sits at the bottom edge — computed from the two heights
 * the list has just been HANDED, not from its own frame bookkeeping.
 *
 * `FlatList.scrollToEnd` cannot be used for the opening pin (POD-1251).
 * Without `getItemLayout`, VirtualizedList derives the end offset from
 * `_averageCellLength * lastIndex`, and on the first content-size change no cell
 * has been measured yet, so the average is 0 and the "end" it scrolls to is 0.
 * The feed then opens at the OLDEST loaded row and — on a hibernated session,
 * where nothing further ever arrives to grow the content again — stays there,
 * with the newest message a screen and a half below and the jump-to-newest pill
 * hidden, because the list believes it is already at the tail.
 *
 * Overshoot is safe and deliberate: both the DOM and the native scroll views
 * clamp to the maximum offset, so a viewport height that has not been measured
 * yet (0) still lands exactly at the bottom.
 */
export function tailOffset(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - Math.max(0, viewportHeight))
}
