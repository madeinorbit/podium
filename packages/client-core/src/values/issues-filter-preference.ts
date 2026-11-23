import type { BoardFilter } from './issue-board-filter'

/**
 * THE TASKS FILTERS THAT FOLLOW THE MEMBER (POD-6294; design §2.2, MU-09).
 *
 * - `assignedTo`: whose tasks the Tasks view lists. `me` (the default), `all`
 *   (every member's), or one member's id. It applies only on a shared instance
 *   (two or more active members); a one-member instance lists what it always did.
 * - `showAgentTasks`: internal agent tasks at top level. It used to be a Display
 *   option; it is a filter now.
 *
 * Both live on one per-member replicated row (`podium.issues.filters`), so each
 * person's choice is their own and follows them across devices. The other
 * facets (priority, state, status, projects, search) stay per screen.
 *
 * ONE-TIME MIGRATION. Until the member's filters row carries `showAgentTasks`,
 * the value is read from the Display row, where it lived before. The first
 * write saves it here, and from then on the Display row's copy is ignored. The
 * Display row is never rewritten for this (expand-only): an older client still
 * reads its own copy there.
 */
export type IssuesAssignedTo = 'me' | 'all' | (string & {})

export interface IssuesFilterPreference {
  assignedTo: IssuesAssignedTo
  showAgentTasks: boolean
  /** Fields this build does not own on the row, kept on write. */
  source: Record<string, unknown>
}

/** What Reset puts back: your own tasks, agent tasks hidden. */
export const DEFAULT_ISSUES_FILTERS: Readonly<Omit<IssuesFilterPreference, 'source'>> = {
  assignedTo: 'me',
  showAgentTasks: false,
}

function objectOf(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Parse the member's filters row; `legacyDisplay` is the Display row, read
 *  only for a `showAgentTasks` the filters row does not hold yet. */
export function readIssuesFilters(
  raw: string | null,
  legacyDisplay: string | null,
): IssuesFilterPreference {
  const source = objectOf(raw) ?? {}
  const assigned = source.assignedTo
  const showAgentTasks =
    typeof source.showAgentTasks === 'boolean'
      ? source.showAgentTasks
      : objectOf(legacyDisplay)?.showAgentTasks === true
  return {
    assignedTo: typeof assigned === 'string' && assigned !== '' ? assigned : 'me',
    showAgentTasks,
    source,
  }
}

export function writeIssuesFilters(filters: IssuesFilterPreference): string {
  return JSON.stringify({
    ...filters.source,
    assignedTo: filters.assignedTo,
    showAgentTasks: filters.showAgentTasks,
  })
}

/**
 * The assignee facet the board filters by: a member id, or undefined for no
 * narrowing. `all`, a one-member instance and a roster not loaded yet all list
 * every assignee's tasks.
 */
export function assigneeFacet(
  assignedTo: IssuesAssignedTo,
  roster: { shared: boolean; viewer: string | undefined },
): string | undefined {
  if (!roster.shared || assignedTo === 'all') return undefined
  return assignedTo === 'me' ? roster.viewer : assignedTo
}

/**
 * How many filters differ from Reset (Me, agent tasks off, nothing else). The
 * free-text search has its own field and is not counted. On a one-member
 * instance Assigned to is not offered, so it never counts.
 */
export function activeFilterCount(
  filter: BoardFilter,
  filters: Pick<IssuesFilterPreference, 'assignedTo' | 'showAgentTasks'>,
  shared: boolean,
): number {
  let count = 0
  if (shared && filters.assignedTo !== 'me') count += 1
  if (filters.showAgentTasks) count += 1
  if (filter.priority !== undefined) count += 1
  if (filter.status !== undefined) count += 1
  if (filter.stage !== undefined) count += 1
  if (filter.projectPaths?.length) count += 1
  if (filter.archived) count += 1
  if (filter.deleted) count += 1
  return count
}
