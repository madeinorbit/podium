import { useCallback, useMemo } from 'react'
import { useUiState } from '../client/hooks'
import {
  useOptimisticPreferences,
  usePoolPreferences,
} from './mobile-preferences'

/**
 * Collapsed state over a DYNAMIC key list, persisted per key through the
 * replicated ui-state store — the many-key sibling of `useCollapsed`, for the
 * Work tab's per-project bands whose list changes with the data [POD-724].
 *
 * OPTIMISTIC, DEFERRED, RECONCILED — in that order, and each word is a fix:
 *
 *  - OPTIMISTIC: the tap flips the local set synchronously and renders from
 *    that. Nothing about the flip waits on the store.
 *  - DEFERRED: the ui-state write is real work — canonical-key routing, the
 *    durable outbox enqueue with its storage persist, a drain kick, and a
 *    synchronous notify of every ui-state subscriber in the app (all mounted
 *    tab screens). All of that used to run inside the press handler, AHEAD of
 *    React's commit, so the fold could only paint after the store had finished
 *    its bookkeeping. The write now happens on the next macrotask, after the
 *    collapse is on screen.
 *  - RECONCILED: a pending overlay keeps the optimistic value authoritative
 *    against any store notification that lands inside the deferred window, and
 *    is released only once this hook's own write has gone through — at which
 *    point the store (whose layout port is itself synchronously optimistic)
 *    agrees. An EXTERNAL write with no local toggle in flight (the desk folding
 *    a band) still lands on the next ui-state tick, exactly as before.
 */
export function useCollapsedSet(
  keys: readonly string[],
  storageKeyFor: (key: string) => string,
): { collapsed: ReadonlySet<string>; toggle: (key: string) => void } {
  const uiState = useUiState()
  const storageKeys = useMemo(() => keys.map(storageKeyFor), [keys, storageKeyFor])
  const values = usePoolPreferences(storageKeys)
  const { overlay, pending } = useOptimisticPreferences(uiState)
  const collapsed = useMemo(() => {
    const next = new Set<string>()
    keys.forEach((key, index) => {
      const storageKey = storageKeys[index]
      if (storageKey !== undefined && (pending.get(storageKey) ?? values[index]) === 'true')
        next.add(key)
    })
    return next
  }, [keys, pending, storageKeys, values])
  const toggle = useCallback(
    (key: string) => {
      const storageKey = storageKeyFor(key)
      const value = overlay.get(storageKey) ?? values[keys.indexOf(key)]
      overlay.set(storageKey, String(value !== 'true'), true)
    },
    [keys, overlay, storageKeyFor, values],
  )
  return { collapsed, toggle }
}
