import type { IssueStage, IssueWire } from '@podium/protocol'

export const STAGE_LABELS: Record<IssueStage, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
}

export function issueCardModel(issue: IssueWire): {
  title: string
  typeLabel: string
  labels: string[]
  needsHuman: boolean
  seqLabel: string
  assignee?: string
  subProgress?: { done: number; total: number }
  isBlocked: boolean
  isBlocking: boolean
  sessionCount: number
  dueLabel?: string
  estimateLabel?: string
} {
  const dueLabel = issue.dueAt
    ? new Date(issue.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : undefined
  return {
    title: issue.title,
    typeLabel: issue.type,
    labels: issue.labels,
    needsHuman: issue.needsHuman,
    seqLabel: `#${issue.seq}`,
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    ...(issue.childCount > 0 ? { subProgress: { done: issue.childDoneCount, total: issue.childCount } } : {}),
    isBlocked: issue.blocked,
    isBlocking: issue.dependents.some((d) => d.type === 'blocks'),
    sessionCount: issue.sessionSummary.total,
    ...(dueLabel ? { dueLabel } : {}),
    ...(issue.estimateMin != null ? { estimateLabel: `${issue.estimateMin}m` } : {}),
  }
}
