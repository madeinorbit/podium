import { formatLong, type IssueStage, type IssueWire, issueDisplayRef } from '@podium/protocol'

export const STAGE_LABELS: Record<IssueStage, string> = {
  proposed: 'Proposed',
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
}

/** The short human-facing ref for an issue row/label (#474): `POD-13` (falls
 *  back to `#13` for legacy payloads). The single accessor every render site uses. */
export function issueRefLabel(issue: Pick<IssueWire, 'seq' | 'displayRef'>): string {
  return issueDisplayRef(issue)
}

/** The long form for a hover/label: `POD-13 · <title>` (title truncated ~40). */
export function issueRefLong(issue: Pick<IssueWire, 'seq' | 'displayRef' | 'title'>): string {
  return formatLong(issueDisplayRef(issue), issue.title)
}

/** Hover text for any issue row/reference — the canonical long form with the
 *  FULL title (#474 spec §display), plus the internal id on a second line so
 *  agents' `iss_…` references can still be matched by eye (#21). */
export function issueIdTitle(
  issue: Pick<IssueWire, 'seq' | 'id' | 'displayRef' | 'title'>,
): string {
  return `${issueDisplayRef(issue)} · ${issue.title}\n${issue.id}`
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
    seqLabel: issueDisplayRef(issue),
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    ...(issue.childCount > 0
      ? { subProgress: { done: issue.childDoneCount, total: issue.childCount } }
      : {}),
    isBlocked: issue.blocked,
    isBlocking: issue.dependents.some((d) => d.type === 'blocks'),
    sessionCount: issue.sessionSummary.total,
    ...(dueLabel ? { dueLabel } : {}),
    ...(issue.estimateMin != null ? { estimateLabel: `${issue.estimateMin}m` } : {}),
  }
}
