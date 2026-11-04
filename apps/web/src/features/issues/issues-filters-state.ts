import { useStoreHandle } from '@podium/client-core/react'
import {
  ISSUES_DISPLAY_KEY,
  ISSUES_FILTERS_KEY,
  type RoutedUiState,
} from '@podium/client-core/ui-state'
import {
  type IssuesFilterPreference,
  readIssuesFilters,
  writeIssuesFilters,
} from '@podium/client-core/values'
import { memberRoster } from '@podium/client-graph/member-roster'
import { useCallback, useMemo } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { usePersistedUiValue } from '@/lib/use-persisted-ui-state'

const rawOf = (raw: string | null): string | null => raw

/**
 * The member's own Tasks filters (POD-6294): Assigned to and Show agent tasks,
 * on their replicated `podium.issues.filters` row. Until that row holds
 * `showAgentTasks`, the Display row's old value is read (the one-time move);
 * the first write saves it here.
 */
export function useIssuesFilters(): [
  IssuesFilterPreference,
  (next: Omit<IssuesFilterPreference, 'source'>) => void,
] {
  const ui = useStoreHandle().access.uiState as RoutedUiState | undefined
  const raw = usePersistedUiValue(ISSUES_FILTERS_KEY, rawOf)
  const legacyDisplay = usePersistedUiValue(ISSUES_DISPLAY_KEY, rawOf)
  const filters = useMemo(() => readIssuesFilters(raw, legacyDisplay), [raw, legacyDisplay])
  const set = useCallback(
    (next: Omit<IssuesFilterPreference, 'source'>) => {
      ui?.set(ISSUES_FILTERS_KEY, writeIssuesFilters({ ...next, source: filters.source }))
    },
    [ui, filters.source],
  )
  return [filters, set]
}

/**
 * Whether the multi-user task rules apply, and who the viewer is, as scalars
 * for the (non-observer) Tasks view. Empty until the roster loads, which is the
 * one-member answer.
 */
export function useMemberScope(): { shared: boolean; viewer: string | undefined } {
  const key = useWorklistPoolProjection((pool) => {
    const roster = memberRoster(pool)
    return roster.shared ? `shared:${roster.currentMemberId ?? ''}` : 'single'
  }, 'single')
  return useMemo(() => {
    if (!key.startsWith('shared:')) return { shared: false, viewer: undefined }
    const viewer = key.slice('shared:'.length)
    return { shared: true, viewer: viewer || undefined }
  }, [key])
}
