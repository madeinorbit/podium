import { useCallback, useEffect, useRef, useState } from 'react'
import { useUiState } from '../client/hooks'

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
  /** Optimistic flips whose persist has not run yet: key → desired collapsed. */
  const pending = useRef(new Map<string, boolean>())

  const read = useCallback((): ReadonlySet<string> => {
    const next = new Set<string>()
    for (const key of keys) {
      const wanted = pending.current.get(key) ?? uiState.get(storageKeyFor(key)) === 'true'
      if (wanted) next.add(key)
    }
    return next
  }, [keys, storageKeyFor, uiState])

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(read)
  useEffect(() => {
    const refresh = (): void => {
      setCollapsed((prev) => {
        const next = read()
        if (prev.size === next.size && [...next].every((key) => prev.has(key))) return prev
        return next
      })
    }
    refresh()
    return uiState.subscribe(refresh)
  }, [read, uiState])

  const toggle = useCallback(
    (key: string) => {
      const storageKey = storageKeyFor(key)
      const next = !(pending.current.get(key) ?? uiState.get(storageKey) === 'true')
      pending.current.set(key, next)
      setCollapsed((prev) => {
        const flipped = new Set(prev)
        if (next) flipped.add(key)
        else flipped.delete(key)
        return flipped
      })
      // Persist AFTER the flip has painted. Deliberately NOT cancelled on
      // unmount: folding a band and immediately navigating away must still
      // save, and the callback touches only the store and the ref.
      setTimeout(() => {
        const wanted = pending.current.get(key)
        if (wanted === undefined) return
        uiState.set(storageKey, String(wanted))
        // Release the overlay only if no NEWER toggle superseded this one —
        // a rapid double-tap re-arms `pending` and its own persist wins.
        if (pending.current.get(key) === wanted) pending.current.delete(key)
      }, 0)
    },
    [storageKeyFor, uiState],
  )

  return { collapsed, toggle }
}
