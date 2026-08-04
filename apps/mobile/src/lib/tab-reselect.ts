/**
 * Tab re-selection bus [POD-366].
 *
 * Tapping the tab you are already on is a real gesture on iOS: it scrolls the
 * screen to the top. The bar used to `return` early in that case, so the tap
 * did nothing at all. `@react-navigation/native`'s `useScrollToTop` is not
 * directly importable under bun's isolated install (see TabBar), so the bar
 * announces the re-tap here and each tab root listens.
 */
type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

/** Called by the tab bar when the already-focused tab is tapped. */
export function emitTabReselect(routeName: string): void {
  for (const listener of listeners.get(routeName) ?? []) listener()
}

/** Subscribe a tab root to its own re-taps. Returns an unsubscribe. */
export function onTabReselect(routeName: string, listener: Listener): () => void {
  const set = listeners.get(routeName) ?? new Set<Listener>()
  set.add(listener)
  listeners.set(routeName, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(routeName)
  }
}
