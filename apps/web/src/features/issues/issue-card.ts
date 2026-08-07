import { ISSUE_STAGE_LABELS } from '@podium/client-core/viewmodels'
import type { IssueStage } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import type { IssueViewModel } from '@/app/store'

export const STAGE_LABELS: Record<IssueStage, string> = { ...ISSUE_STAGE_LABELS }

/** The ref/label formatters now live in `@/lib/issue-label` — they are pure
 *  string helpers and other features (merge-queue) need them without importing
 *  across the feature boundary. Re-exported here only for the call sites that
 *  still reach through this module; import from `@/lib/issue-label` in new code. */
export { issueIdTitle, issueRefLabel, issueRefLong } from '@/lib/issue-label'

export function issueCardModel(issue: IssueViewModel): {
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
    sessionCount: issue.sessionSummary?.total ?? 0,
    ...(dueLabel ? { dueLabel } : {}),
    ...(issue.estimateMin != null ? { estimateLabel: `${issue.estimateMin}m` } : {}),
  }
}
