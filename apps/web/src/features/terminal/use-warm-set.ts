import { type SessionId } from '@podium/model/browser'
import { useEffect, useRef, useState } from 'react'
import { computeWarmSet, updateRecency } from './warm-set'

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
  return window.matchMedia('(max-width: 768px)').matches
    ? HEAVY_PANEL_RESIDENCY_BUDGET.mobile
    : HEAVY_PANEL_RESIDENCY_BUDGET.desktop
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
  // Recompute whenever the active pane(s) or the open-session set changes.
  const key = `${activeIds.join(',')}|${allSessionIds.join(',')}`
  useEffect(() => {
    recency.current = updateRecency(recency.current, activeIds, allSessionIds)
    setWarm(computeWarmSet(recency.current, activeIds, residencyBudget()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return warm
}
