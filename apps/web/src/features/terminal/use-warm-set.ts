import { type SessionId } from '@podium/model/browser'
import { useEffect, useRef, useState } from 'react'
import { computeWarmSet, updateRecency } from './warm-set'

const MOBILE_QUERY = '(max-width: 768px)'

/**
 * A mounted AgentPanel is a heavy residency unit: the real-browser probe shows
 * that each unit retains one xterm/WebGL renderer, one PTY hub attachment, one
 * transcript subscription and about 97 panel DOM nodes. Three desktop units
 * preserve the active panel plus two genuinely warm reveals while avoiding the
 * old eight-panel GPU/DOM/subscription footprint. Narrow devices admit one
 * fewer background unit; active split panes remain exempt in computeWarmSet.
 */
export const HEAVY_PANEL_RESIDENCY_BUDGET = {
  desktop: 3,
  mobile: 2,
} as const

function residencyBudget(): number {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return HEAVY_PANEL_RESIDENCY_BUDGET.desktop
  }
  return window.matchMedia(MOBILE_QUERY).matches
    ? HEAVY_PANEL_RESIDENCY_BUDGET.mobile
    : HEAVY_PANEL_RESIDENCY_BUDGET.desktop
}

function useResidencyBudget(): number {
  const [budget, setBudget] = useState(residencyBudget)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia(MOBILE_QUERY)
    const onChange = (): void => setBudget(
      query.matches ? HEAVY_PANEL_RESIDENCY_BUDGET.mobile : HEAVY_PANEL_RESIDENCY_BUDGET.desktop,
    )
    onChange()
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    }
    query.addListener?.(onChange)
    return () => query.removeListener?.(onChange)
  }, [])

  return budget
}

/**
 * Returns the set of session ids that should stay MOUNTED: the active pane(s)
 * plus the most-recently-viewed others within the measured heavy-panel budget.
 * Sessions beyond the budget are evicted (the caller unmounts them); selecting
 * one re-enters the warm set and remounts it through the existing cold route.
 */
export function useWarmSet(allSessionIds: SessionId[], activeIds: SessionId[]): Set<SessionId> {
  const recency = useRef<SessionId[]>([])
  const [warm, setWarm] = useState<Set<SessionId>>(() => new Set(activeIds))
  const budget = useResidencyBudget()
  // Recompute whenever the active pane(s) or the open-session set changes.
  const key = `${activeIds.join(',')}|${allSessionIds.join(',')}`
  useEffect(() => {
    recency.current = updateRecency(recency.current, activeIds, allSessionIds)
    setWarm(computeWarmSet(recency.current, activeIds, budget))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, budget])
  return warm
}
