import { shallowEqual } from '../src/shallow-equal'
import { recordStorePublish, recordStoreSubscriber } from '../src/perf/store-stats'
type StoreListener = () => void
interface SubscriptionStore<T> { getSnapshot(): T; publish(next: T, changedKeys?: ReadonlySet<string>, nested?: boolean): void; subscribe(listener: StoreListener): () => void }
export function createSubscriptionStore<T>(
  initial: T,
  isEqual: (a: T, b: T) => boolean = shallowEqual,
  statsOwner: object = {},
): SubscriptionStore<T> {
  let snapshot = initial
  const listeners = new Set<StoreListener>()
  return {
    getSnapshot: () => snapshot,
    publish(next: T, changedKeys?: ReadonlySet<string>, nested?: boolean): void {
      if (isEqual(snapshot, next)) return
      snapshot = next
      const publication = recordStorePublish(statsOwner, changedKeys, nested)
      // Copy before iterating: a listener may unsubscribe (or subscribe) others.
      for (const l of [...listeners]) {
        recordStoreSubscriber(statsOwner, publication)
        l()
      }
    },
    subscribe(listener: StoreListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
