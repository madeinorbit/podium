/** Fractional layout tolerance; proximity alone never declares follow intent. */
export const TAIL_SLACK = 2

/** How close a reader's own scroll must come to the bottom to count as being
 * there again: Newest hides and live output resumes following. Wider than
 * TAIL_SLACK because a finger cannot land on an exact pixel. */
export const FOLLOW_REARM_SLACK = 24

export function measureAtTail(
  contentOffsetY: number,
  layoutHeight: number,
  contentHeight: number,
  slack = TAIL_SLACK,
): boolean {
  return contentOffsetY + layoutHeight >= contentHeight - slack
}

/** Use actual measured content/viewport heights, including composer padding.
 * FlatList.scrollToEnd instead estimates unmeasured variable-height cells. */
export function tailOffset(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - Math.max(0, viewportHeight))
}
