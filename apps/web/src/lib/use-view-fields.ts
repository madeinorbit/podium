import { compareShallow, reaction } from 'mobx'
import { useMemo, useSyncExternalStore } from 'react'

/** Subscribe legacy hook callers to a model without copying its answer into React state. */
export function useViewFields<T>(view: T, read: (view: T) => readonly unknown[]): void {
  const subscription = useMemo(() => {
    let revision = 0
    return {
      getSnapshot: () => revision,
      subscribe: (notify: () => void) =>
        reaction(
          () => read(view),
          () => {
            revision++
            notify()
          },
          { equals: compareShallow, fireImmediately: true },
        ),
    }
  }, [view, read])
  useSyncExternalStore(subscription.subscribe, subscription.getSnapshot, subscription.getSnapshot)
}
