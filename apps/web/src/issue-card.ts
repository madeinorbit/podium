import type { IssueStage, IssueWire } from '@podium/protocol'

export const STAGE_LABELS: Record<IssueStage, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  review: 'Review',
  verifying: 'Verifying',
  done: 'Done',
}

export function issueCardModel(issue: IssueWire): {
  title: string
  subtitle: string
  phaseBadges: { label: string; tone: string }[]
  hasSuggestion: boolean
  priorityLabel: string
  typeLabel: string
  statusDot: 'ready' | 'blocked' | 'deferred' | 'closed' | 'open'
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
  const repo = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
  const count = issue.sessionSummary.total
  const subtitle = `#${issue.seq} · ${repo} · ${count} session${count === 1 ? '' : 's'}`
  const phaseBadges = Object.entries(issue.sessionSummary.byPhase).map(([phase, n]) => ({ label: `${n} ${phase}`, tone: phase }))
  const statusDot: 'ready' | 'blocked' | 'deferred' | 'closed' | 'open' =
    issue.stage === 'done' || issue.closedReason
      ? 'closed'
      : issue.deferred
        ? 'deferred'
        : issue.blocked
          ? 'blocked'
          : issue.ready
            ? 'ready'
            : 'open'
  const dueLabel = issue.dueAt
    ? new Date(issue.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : undefined
  return {
    title: issue.title,
    subtitle,
    phaseBadges,
    hasSuggestion: Boolean(issue.suggestedStage),
    priorityLabel: `P${issue.priority}`,
    typeLabel: issue.type,
    statusDot,
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
