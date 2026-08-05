/**
 * Whether the tab bar is currently minimized to icons [POD-420].
 *
 * A module-level store rather than context for the same reason ./tab-reselect is
 * one: the publishers are scroll handlers on four sibling screens and the single
 * subscriber is the tab bar, which is not their ancestor OR their descendant —
 * it is the navigator's chrome. Routing this through React state would mean
 * re-rendering every screen on a scroll gesture to move a bar none of them own.
 *
 * On iOS 26 this behaviour is `tabBarMinimizeBehavior`, and it is opt-in there
 * too: the default bar does not do it.
 */
type Listener = (minimized: boolean) => void

const listeners = new Set<Listener>()
let minimized = false

export function getTabBarMinimized(): boolean {
  return minimized
}

export function setTabBarMinimized(next: boolean): void {
  if (next === minimized) return
  minimized = next
  for (const listener of listeners) listener(next)
}

export function subscribeTabBarMinimized(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Below this much travel, a scroll is a thumb settling, not a direction. */
const THRESHOLD = 12
/** Near the top the bar is always up — there is nothing to make room for. */
const TOP = 24

/**
 * Fold a scroll position into the bar's state. Kept pure and separate from the
 * hook so the rules are testable without a scroll event: it returns the next
 * anchor along with the decision, and `null` means "not enough travel to say".
 */
export function minimizeDecision(
  y: number,
  anchor: number,
): { minimized: boolean; anchor: number } | null {
  if (y <= TOP) return { minimized: false, anchor: y }
  const dy = y - anchor
  if (Math.abs(dy) < THRESHOLD) return null
  return { minimized: dy > 0, anchor: y }
}
