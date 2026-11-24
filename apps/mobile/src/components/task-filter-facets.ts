import {
  BOARD_STATE_FILTERS,
  type BoardFilter,
  ISSUES_ORDERING_LABELS,
  type IssuesAssignedTo,
  type IssuesOrdering,
} from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/loading'
import { isGone } from '@podium/client-graph/lookup'
import type { MemberRoster } from '@podium/client-graph/member-roster'
import {
  ALL_ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type IssueStatus,
  machinePathBasename,
} from '@podium/model'
import { memberDisplayName } from '../client/member-roster'
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

export type Facet = 'assignedTo' | 'project' | 'stage' | 'priority' | 'ordering' | 'status'

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
  assignedTo?: IssuesAssignedTo
  roster?: Pick<MemberRoster, 'shared' | 'members' | 'currentMemberId' | 'nameOf'> | undefined
  /** Filters that differ from Reset; defaults to the sheet's own facets. */
  count?: number
  onFilter: (filter: BoardFilter) => void
  onOrdering: (ordering: IssuesOrdering) => void
  onShowDone: (show: boolean) => void
  onShowAgentTasks: (show: boolean) => void
  onAssignedTo?: (assignedTo: IssuesAssignedTo) => void
  onReset?: () => void
  onClose: () => void
}

/** The board's filter groups, in the sheet's order: what to show, then how. */
export const FILTER_FACETS: readonly Facet[] = ['assignedTo', 'project', 'stage', 'priority']
export const DISPLAY_FACETS: readonly Facet[] = ['ordering']
export const MORE_FACETS: readonly Facet[] = ['status']

function withFilter<K extends keyof BoardFilter>(
  filter: BoardFilter,
  key: K,
  value: BoardFilter[K] | undefined,
): BoardFilter {
  const next: BoardFilter = { ...filter }
  if (value === undefined) delete next[key]
  else Object.assign(next, { [key]: value })
  return next
}

/**
 * The project scope: the sheet's first row and the Tasks tab's leading bar
 * picker on iOS, so both offer the same choices.
 */
export function useProjectFacet({
  filter,
  onFilter,
}: Pick<TaskFiltersSheetProps, 'filter' | 'onFilter'>): FacetConfig {
  const repositoryPaths = useLaunchRepositoryPaths()
  const repos = repositoryPaths === LOADING || isGone(repositoryPaths) ? [] : repositoryPaths
  const project = filter.projectPaths?.length === 1 ? filter.projectPaths[0]! : ANY
  return {
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
    apply: (value) =>
      onFilter(withFilter(filter, 'projectPaths', value === ANY ? undefined : [value])),
  }
}

/**
 * One filter-and-display sheet, two renderers: the facets are built here.
 * Assigned to (on a shared instance) and Agent tasks are the member's own
 * saved filters, the same ones the web's Filter menu writes (POD-6294,
 * POD-6297); the other facets belong to this screen. Facets a renderer does
 * not get (Assigned to off a shared instance) are absent from `configs`.
 */
export function useTaskFilterFacets(
  props: Pick<
    TaskFiltersSheetProps,
    | 'filter'
    | 'ordering'
    | 'onFilter'
    | 'onOrdering'
    | 'assignedTo'
    | 'roster'
    | 'count'
    | 'onAssignedTo'
    | 'onReset'
  >,
) {
  const { filter, ordering, onFilter, onOrdering, roster, count, onAssignedTo, onReset } = props
  const assignedTo = props.assignedTo ?? 'me'
  const shared = roster?.shared === true && onAssignedTo !== undefined
  const others = shared
    ? (roster?.members ?? []).filter((member) => member.id !== roster?.currentMemberId)
    : []
  const set = <K extends keyof BoardFilter>(key: K, value: BoardFilter[K] | undefined) =>
    onFilter(withFilter(filter, key, value))
  const project = useProjectFacet({ filter, onFilter })
  const assignedToConfig: FacetConfig = {
    label: 'Assigned to',
    value: assignedTo,
    options: [
      { value: 'me', label: 'Me' },
      { value: 'all', label: 'All users' },
      ...others.map((member) => ({
        value: member.id,
        label: memberDisplayName(roster, member.id),
      })),
    ],
    apply: (value) => onAssignedTo?.(value),
  }
  const facets: Record<Exclude<Facet, 'assignedTo'>, FacetConfig> = {
    project,
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
  const configs: Partial<Record<Facet, FacetConfig>> = shared
    ? { assignedTo: assignedToConfig, ...facets }
    : facets
  const reset = () => (onReset ? onReset() : onFilter(filter.text ? { text: filter.text } : {}))
  const activeCount = count ?? Object.keys(filter).filter((key) => key !== 'text').length
  return { configs, set, reset, activeCount }
}
