import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'

/** How long a list's order must hold still after a tab opens before reorders animate. */
export const LIST_SETTLE_MS = 1200

/**
 * Whether a native list's row animations are armed. They stay off through the
 * first population and until the list's order (`revision`) has held still after
 * a tab opens (cached rows replaced by fresh ones); only later, genuine changes
 * (a resume catch-up, a live re-sort, a fold) animate. Callers pass each
 * section's `animation(_:value:)` its revision when armed and a constant when
 * not: arming swaps values with no content change, so it animates nothing.
 */
export function useSettledOrder(revision: number, ready: boolean): boolean {
  const [armed, setArmed] = useState(false)
  // Hidden tabs disarm: rows that change while away appear in place on return.
  useFocusEffect(useCallback(() => () => setArmed(false), []))
  // biome-ignore lint/correctness/useExhaustiveDependencies: every order change restarts the settle
  useEffect(() => {
    if (armed || !ready) return
    const timer = setTimeout(() => setArmed(true), LIST_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [armed, ready, revision])
  return armed
}

/** A section's `animation(_:value:)` value: its order once armed, a constant before. */
export function sectionAnimationValue(armed: boolean, revision: number): number {
  return armed ? revision : 0
}
