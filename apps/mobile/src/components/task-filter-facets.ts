import {
  BOARD_STATE_FILTERS,
  type BoardFilter,
  ISSUES_ORDERING_LABELS,
  type IssuesOrdering,
} from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/loading'
import { isGone } from '@podium/client-graph/lookup'
import {
  ALL_ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type IssueStatus,
  machinePathBasename,
} from '@podium/model'
import { useLaunchRepositoryPaths } from '../client/use-launch-inputs'
import type { NativePickerOption } from './action-sheet-native'

/**
 * The Filter and display sheet's facets, shared by both renderers.
 *
 * PLATFORM-NEUTRAL ON PURPOSE: `TaskFiltersSheet.ios.tsx` cannot value-import
 * from `./TaskFiltersSheet`, because on iOS Metro resolves that specifier to the
 * .ios file itself (POD-2382 crash). Shared logic lives here, under its own
 * base name, and `platform-self-import.test.ts` guards the rule.
 */
export const ANY = '__any__'

export type Facet = 'project' | 'stage' | 'priority' | 'ordering' | 'status'

export interface FacetConfig {
  label: string
  value: string
  options: readonly NativePickerOption[]
  apply: (value: string) => void
}

export interface TaskFiltersSheetProps {
  visible: boolean
  filter: BoardFilter
  ordering: IssuesOrdering
  showDone: boolean
  showAgentTasks: boolean
  onFilter: (filter: BoardFilter) => void
  onOrdering: (ordering: IssuesOrdering) => void
  onShowDone: (show: boolean) => void
  onShowAgentTasks: (show: boolean) => void
  onClose: () => void
}

/** The board's filter groups, in the sheet's order: what to show, then how. */
export const FILTER_FACETS: readonly Facet[] = ['project', 'stage', 'priority']
export const DISPLAY_FACETS: readonly Facet[] = ['ordering']
export const MORE_FACETS: readonly Facet[] = ['status']

/** One filter-and-display sheet, two renderers: the facets are built here. */
export function useTaskFilterFacets(
  props: Pick<TaskFiltersSheetProps, 'filter' | 'ordering' | 'onFilter' | 'onOrdering'>,
) {
  const { filter, ordering, onFilter, onOrdering } = props
  const repositoryPaths = useLaunchRepositoryPaths()
  const repos = repositoryPaths === LOADING || isGone(repositoryPaths) ? [] : repositoryPaths
  const set = <K extends keyof BoardFilter>(key: K, value: BoardFilter[K] | undefined) => {
    const next: BoardFilter = { ...filter }
    if (value === undefined) delete next[key]
    else Object.assign(next, { [key]: value })
    onFilter(next)
  }
  const project = filter.projectPaths?.length === 1 ? filter.projectPaths[0]! : ANY
  const configs: Record<Facet, FacetConfig> = {
    project: {
      label: 'Project',
      value: project,
      options: [
        { value: ANY, label: 'All' },
        ...(project !== ANY && !repos.includes(project) ? [project] : []).map((value) => ({
          value,
          label: machinePathBasename(value),
        })),
        ...repos.map((value) => ({ value, label: machinePathBasename(value) })),
      ],
      apply: (value) => set('projectPaths', value === ANY ? undefined : [value]),
    },
    priority: {
      label: 'Priority',
      value: filter.priority == null ? ANY : String(filter.priority),
      options: [
        { value: ANY, label: 'Any' },
        ...[0, 1, 2, 3, 4].map((value) => ({ value: String(value), label: `P${value}` })),
      ],
      apply: (value) => set('priority', value === ANY ? undefined : Number(value)),
    },
    status: {
      label: 'State',
      value: filter.status ?? ANY,
      options: [
        { value: ANY, label: 'Any' },
        ...BOARD_STATE_FILTERS.map((value) => ({
          value,
          label: value[0]!.toUpperCase() + value.slice(1),
        })),
      ],
      apply: (value) =>
        set('status', value === ANY ? undefined : (value as NonNullable<BoardFilter['status']>)),
    },
    stage: {
      label: 'Status',
      value: filter.stage ?? ANY,
      options: [
        { value: ANY, label: 'Any' },
        ...ALL_ISSUE_STATUSES.map((value) => ({ value, label: ISSUE_STATUS_LABELS[value] })),
      ],
      apply: (value) => set('stage', value === ANY ? undefined : (value as IssueStatus)),
    },
    ordering: {
      label: 'Order',
      value: ordering,
      options: (Object.keys(ISSUES_ORDERING_LABELS) as IssuesOrdering[]).map((value) => ({
        value,
        label: ISSUES_ORDERING_LABELS[value],
      })),
      apply: (value) => onOrdering(value as IssuesOrdering),
    },
  }
  /** Clear every filter, keeping the search text the field still shows. */
  const reset = () => onFilter(filter.text ? { text: filter.text } : {})
  const activeCount = Object.keys(filter).filter((key) => key !== 'text').length
  return { configs, set, reset, activeCount }
}
