import { ISSUES_DISPLAY_KEY, ISSUES_FILTERS_KEY } from '@podium/client-core/ui-state'
import {
  type IssuesFilterPreference,
  readIssuesFilters,
  writeIssuesFilters,
} from '@podium/client-core/values'
import { useCallback, useMemo } from 'react'
import { useUiState } from '../client/hooks'
import { usePoolPreferences } from './mobile-preferences'

const KEYS = [ISSUES_FILTERS_KEY, ISSUES_DISPLAY_KEY] as const

/**
 * The member's own Tasks filters (POD-6294, on the phone since POD-6297):
 * Assigned to and Show agent tasks, on the same replicated
 * `podium.issues.filters` row the web writes, so a choice made on one device
 * is the phone's too. Until that row holds `showAgentTasks`, the Display row's
 * old value is read (the one-time move); the first write saves it here.
 */
export function useIssuesFilters(): [
  IssuesFilterPreference,
  (next: Omit<IssuesFilterPreference, 'source'>) => void,
] {
  const ui = useUiState()
  const [raw, legacyDisplay] = usePoolPreferences(KEYS)
  const filters = useMemo(
    () => readIssuesFilters(raw ?? null, legacyDisplay ?? null),
    [raw, legacyDisplay],
  )
  const set = useCallback(
    (next: Omit<IssuesFilterPreference, 'source'>) =>
      ui.set(ISSUES_FILTERS_KEY, writeIssuesFilters({ ...next, source: filters.source })),
    [ui, filters.source],
  )
  return [filters, set]
}
