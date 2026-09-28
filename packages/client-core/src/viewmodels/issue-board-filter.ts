import { ISSUE_STATUS_LABELS, type IssueStatus, type IssueWire, issueStatusOf } from '@podium/model'

/** Every task facet shared by the desktop board and the native iPhone list. */
export interface BoardFilter {
  text?: string
  priority?: number
  projectPaths?: string[]
  status?: 'open' | 'closed' | 'ready' | 'blocked' | 'deferred'
  stage?: IssueStatus
  archived?: boolean
  deleted?: boolean
}

/** The wire facts the shared filter reads. */
export type BoardFilterIssue = Pick<
  IssueWire,
  | 'title'
  | 'description'
  | 'seq'
  | 'displayRef'
  | 'priority'
  | 'repoPath'
  | 'stage'
  | 'closedReason'
  | 'ready'
  | 'blocked'
  | 'deferred'
  | 'archived'
  | 'deletedAt'
>

/** Alphanumerics only so POD-123, pod 123, #123 and 123 share one needle. */
const normalizeRef = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')

function matchesRef(issue: BoardFilterIssue, needle: string): boolean {
  if (!/\d/.test(needle)) return false
  return normalizeRef(issue.displayRef ?? `#${issue.seq}`).includes(needle)
}

/** AND-composed membership used by every task index. Pure and order-preserving. */
export function filterBoardIssues<T extends BoardFilterIssue>(
  issues: readonly T[],
  filter: BoardFilter,
): T[] {
  const text = filter.text?.trim().toLowerCase()
  const refNeedle = text ? normalizeRef(text) : ''
  return issues.filter((issue) => {
    if (issue.deletedAt ? !filter.deleted : issue.archived && !filter.archived) return false
    if (filter.priority != null && issue.priority !== filter.priority) return false
    if (filter.projectPaths?.length && !filter.projectPaths.includes(issue.repoPath)) return false
    if (filter.stage && issueStatusOf(issue) !== filter.stage) return false
    const closed = issue.stage === 'done' || issue.closedReason != null
    if (filter.status === 'open' && closed) return false
    if (filter.status === 'closed' && !closed) return false
    if (filter.status === 'ready' && !issue.ready) return false
    if (filter.status === 'blocked' && !issue.blocked) return false
    if (filter.status === 'deferred' && !issue.deferred) return false
    if (
      text &&
      !`${issue.title} ${issue.description}`.toLowerCase().includes(text) &&
      !matchesRef(issue, refNeedle)
    )
      return false
    return true
  })
}

/** Compact removable summaries for all non-text facets. */
export function filterChips(filter: BoardFilter): { key: keyof BoardFilter; label: string }[] {
  const chips: { key: keyof BoardFilter; label: string }[] = []
  if (filter.priority != null)
    chips.push({ key: 'priority', label: `Priority: P${filter.priority}` })
  if (filter.projectPaths?.length)
    chips.push({
      key: 'projectPaths',
      label:
        filter.projectPaths.length === 1
          ? `Project: ${filter.projectPaths[0]?.split('/').pop() || filter.projectPaths[0]}`
          : `Projects: ${filter.projectPaths.length}`,
    })
  if (filter.status) chips.push({ key: 'status', label: `State: ${filter.status}` })
  if (filter.stage)
    chips.push({ key: 'stage', label: `Status: ${ISSUE_STATUS_LABELS[filter.stage]}` })
  if (filter.archived) chips.push({ key: 'archived', label: 'Archived' })
  if (filter.deleted) chips.push({ key: 'deleted', label: 'Deleted' })
  return chips
}

export function clearChip(filter: BoardFilter, key: keyof BoardFilter): BoardFilter {
  const next = { ...filter }
  delete next[key]
  return next
}
