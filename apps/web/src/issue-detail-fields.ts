import type { IssueWire } from '@podium/protocol'

export interface IssueDetailFields {
  priorityLabel: string
  typeLabel: string
  assignee?: string
  labels: string[]
  deps: { id: string; type: string }[]
  dependents: { id: string; type: string }[]
  comments: { author: string; body: string; createdAt: string }[]
  parentId?: string
  childSummary?: string
  lifecycle?: string
}

/**
 * Pure read-only view-model for the rich `IssueWire` fields shown in the detail
 * drawer (priority/type/assignee/labels, deps, parent/children, lifecycle, and
 * the comment thread). Optional fields are omitted when absent via conditional
 * spread, so callers can render a section only when its key is present.
 */
export function issueDetailFields(issue: IssueWire): IssueDetailFields {
  const lifecycle = issue.supersededBy
    ? `superseded by ${issue.supersededBy}`
    : issue.duplicateOf
      ? `duplicate of ${issue.duplicateOf}`
      : issue.closedReason
        ? `closed: ${issue.closedReason}`
        : undefined
  return {
    priorityLabel: `P${issue.priority}`,
    typeLabel: issue.type,
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    labels: issue.labels,
    deps: issue.deps,
    dependents: issue.dependents,
    comments: issue.comments.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: c.createdAt,
    })),
    ...(issue.parentId ? { parentId: issue.parentId } : {}),
    ...(issue.childCount > 0
      ? { childSummary: `${issue.childDoneCount}/${issue.childCount} done` }
      : {}),
    ...(lifecycle ? { lifecycle } : {}),
  }
}
