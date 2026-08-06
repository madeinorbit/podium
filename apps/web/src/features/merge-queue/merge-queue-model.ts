import { issuePendingDecision } from '@podium/client-core/viewmodels'
import type { IssueViewModel } from '@/app/store'

/** Identity carried by the advisory merge-lock projection. */
export interface MergeQueuePrincipal {
  sessionId: string | null
  issueId: string | null
  label: string
}

export interface ActiveMergeLease extends MergeQueuePrincipal {
  acquiredAt: string
  expiresAt: string
  secondsLeft: number
  note: string | null
}

export interface MergeQueueWaiter extends MergeQueuePrincipal {
  position: number
  enqueuedAt: string
}

export interface MergeQueueLock {
  holder: ActiveMergeLease
  queue: MergeQueueWaiter[]
}

/** The panel's deliberately small data seam. Transport adapts to this union. */
export type MergeQueuePanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      lock: MergeQueueLock | null
      refreshing?: boolean
      /** A failed refresh with a last-good reading still on screen. */
      warning?: string
    }

export interface MergeQueueRepoScope {
  repoId?: string | null
  repoPath: string
}

function belongsToRepo(issue: IssueViewModel, scope: MergeQueueRepoScope): boolean {
  if (scope.repoId && issue.repoId) return issue.repoId === scope.repoId
  return issue.repoPath === scope.repoPath
}

/**
 * Candidates the operator may put into the merge queue. Persisted sort keys are
 * the human-authored order; priority/sequence retain the issue tracker's stable
 * ready ordering for legacy rows without one. A holder or waiter appears in
 * exactly one section, never again as READY.
 */
export function readyMergeCandidates(
  issues: readonly IssueViewModel[],
  scope: MergeQueueRepoScope,
  lock: MergeQueueLock | null,
): IssueViewModel[] {
  const occupied = new Set(
    [lock?.holder.issueId, ...(lock?.queue.map((waiter) => waiter.issueId) ?? [])].filter(
      (id): id is string => Boolean(id),
    ),
  )

  return issues
    .filter(
      (issue) =>
        issuePendingDecision(issue) === 'merge' &&
        !issue.archived &&
        !issue.deletedAt &&
        issue.audience !== 'agent' &&
        belongsToRepo(issue, scope) &&
        !occupied.has(issue.id),
    )
    .sort((a, b) => {
      if (a.sortKey && b.sortKey && a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1
      if (a.sortKey && !b.sortKey) return -1
      if (!a.sortKey && b.sortKey) return 1
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.seq - b.seq
    })
}

export function formatLeaseRemaining(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const remainder = safe % 60
  if (minutes === 0) return `${remainder}s`
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`
}
