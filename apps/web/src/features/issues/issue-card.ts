import { ISSUE_STAGE_LABELS } from '@podium/client-core/viewmodels'
import type { IssueStage } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import type { IssueViewModel } from '@/app/store'

// Pure label helpers live in lib so non-issues features can use them without a
// cross-feature import (features.structure.test.ts). Re-export for issue-local
// call sites that already import from this module.
export { issueIdTitle, issueRefLabel, issueRefLong } from '@/lib/issue-labels'

export const STAGE_LABELS: Record<IssueStage, string> = { ...ISSUE_STAGE_LABELS }

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
