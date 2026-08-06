/** Finger travel required before a release means refresh rather than cancel. */
export const PULL_REFRESH_THRESHOLD = 58

/** The indicator never follows the finger far enough to drag the list chrome. */
const MAX_INDICATOR_TRAVEL = 78

/**
 * Rubber-band resistance for the web indicator. The document and the list stay
 * fixed; only the small status pill moves, so Safari never gets a second visual
 * overscroll to animate behind ours.
 */
export function resistedPullDistance(rawDistance: number): number {
  if (rawDistance <= 0) return 0
  return Math.min(MAX_INDICATOR_TRAVEL, rawDistance * 0.5)
}

export function pullWillRefresh(distance: number): boolean {
  return distance >= PULL_REFRESH_THRESHOLD
}
