import { useEffect, useRef, useState } from 'react'
import { computeWarmSet, updateRecency } from './warm-set'

const DESKTOP_N = 8
const MOBILE_N = 3

function warmCapacity(): number {
  if (typeof window === 'undefined' || !window.matchMedia) return DESKTOP_N
  return window.matchMedia('(max-width: 768px)').matches ? MOBILE_N : DESKTOP_N
}

/**
 * Returns the set of session ids that should stay MOUNTED: the active pane(s)
 * plus the most-recently-viewed others up to an LRU cap (8 desktop / 3 mobile).
 * Sessions beyond the cap are evicted (the caller unmounts them); re-selecting
 * one re-enters the warm set and remounts it cold.
 */
export function useWarmSet(allSessionIds: string[], activeIds: string[]): Set<string> {
  const recency = useRef<string[]>([])
  const [warm, setWarm] = useState<Set<string>>(() => new Set(activeIds))
  // Recompute whenever the active pane(s) or the open-session set changes.
  const key = `${activeIds.join(',')}|${allSessionIds.join(',')}`
  useEffect(() => {
    recency.current = updateRecency(recency.current, activeIds, allSessionIds)
    setWarm(computeWarmSet(recency.current, activeIds, warmCapacity()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return warm
}
