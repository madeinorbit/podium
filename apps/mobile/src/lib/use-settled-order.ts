import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'

/** How long a list's order must hold still after a tab opens before reorders animate. */
export const LIST_SETTLE_MS = 1200

/**
 * The value for a native list's `animation(_:value:)`: a constant until the list
 * has settled, then its order revision. The first population and the first
 * settle after a tab opens (cached rows replaced by fresh ones) apply without
 * animation; only later, genuine order changes (a resume catch-up, a live
 * re-sort) move rows. Arming changes the value with no content change, so the
 * switch itself animates nothing.
 */
export function useSettledOrder(revision: number, ready: boolean): number {
  const [armed, setArmed] = useState(false)
  // Hidden tabs disarm: rows that change while away appear in place on return.
  useFocusEffect(useCallback(() => () => setArmed(false), []))
  // biome-ignore lint/correctness/useExhaustiveDependencies: every order change restarts the settle
  useEffect(() => {
    if (armed || !ready) return
    const timer = setTimeout(() => setArmed(true), LIST_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [armed, ready, revision])
  return armed ? revision : 0
}
