import { useCallback, useRef } from 'react'

/**
 * Stable per-row thunk cache (POD-4421).
 *
 * A parent that passes `onTuck={() => tuck(row.id)}` mints a fresh closure per
 * row per render, which defeats `React.memo` on the row even when the row
 * object itself is stable. This hook returns a stable getter: the getter is
 * created once, and the thunk it returns for a given id is created once and
 * reused across renders. The thunk reads the latest action through a ref, so
 * the action itself never has to be stable for the thunk to stay stable.
 *
 * The cache is pruned to the ids handed in each render so rows that leave the
 * list do not pin closures forever.
 */
export function usePerIdThunk(action: (id: string) => void): {
  forId: (id: string) => () => void
  prune: (activeIds: readonly string[]) => void
} {
  const actionRef = useRef(action)
  actionRef.current = action
  const cacheRef = useRef(new Map<string, () => void>())
  const forId = useCallback((id: string): (() => void) => {
    let fn = cacheRef.current.get(id)
    if (!fn) {
      fn = () => actionRef.current(id)
      cacheRef.current.set(id, fn)
    }
    return fn
  }, [])
  const prune = useCallback((activeIds: readonly string[]): void => {
    const active = new Set(activeIds)
    for (const key of cacheRef.current.keys()) {
      if (!active.has(key)) cacheRef.current.delete(key)
    }
  }, [])
  return { forId, prune }
}

/**
 * A stable action cell: the returned callback keeps one identity for the life
 * of the component while always calling the latest action. Lets list-level
 * row handlers (`onSelectIssue`, `onOpenIssue`, …) stay referentially stable
 * across publishes even though the store actions they close over are recreated
 * per render.
 */
export function useStableAction<T extends (...args: never[]) => unknown>(action: T): T {
  const ref = useRef(action)
  ref.current = action
  return useCallback(
    ((...args: Parameters<T>): ReturnType<T> => ref.current(...args) as ReturnType<T>) as T,
    [],
  )
}
