/**
 * Minimal external subscription store (Phase 4 client-core unification, #15):
 * a snapshot holder with subscribe/getSnapshot semantics, designed for React's
 * `useSyncExternalStore` but with zero React (or DOM) dependency so native
 * clients can share it. The web store publishes its derived value object here
 * once per commit; consumers subscribe to slices via selectors instead of
 * re-rendering on every provider render.
 */

export type StoreListener = () => void

export interface SubscriptionStore<T> {
  /** The current snapshot. Stable identity until `publish` accepts a change. */
  getSnapshot(): T
  /**
   * Replace the snapshot and notify subscribers — unless the next value is
   * shallow-equal to the current one, in which case the OLD snapshot (and its
   * identity) is kept and nobody is notified. This is what stops a provider
   * re-render from fanning out when nothing actually changed.
   */
  publish(next: T): void
  /** Subscribe to snapshot changes. Returns the unsubscribe function. */
  subscribe(listener: StoreListener): () => void
}

/** Shallow equality over own enumerable keys (Object.is per value). */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (
      !Object.hasOwn(b, k) ||
      !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    )
      return false
  }
  return true
}

export function createSubscriptionStore<T>(
  initial: T,
  isEqual: (a: T, b: T) => boolean = shallowEqual,
): SubscriptionStore<T> {
  let snapshot = initial
  const listeners = new Set<StoreListener>()
  return {
    getSnapshot: () => snapshot,
    publish(next: T): void {
      if (isEqual(snapshot, next)) return
      snapshot = next
      // Copy before iterating: a listener may unsubscribe (or subscribe) others.
      for (const l of [...listeners]) l()
    },
    subscribe(listener: StoreListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
