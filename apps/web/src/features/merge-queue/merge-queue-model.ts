import { HEAVY_TEST_LOCK_NAME, MERGE_LOCK_NAME } from '@podium/client-core/react'
import { issuePendingDecision } from '@podium/client-core/viewmodels'
import { isMergeLockName, MERGE_LOCK_PREFIX } from '@podium/protocol'
import type { IssueViewModel } from '@/app/store'

/** Identity carried by an advisory lock projection. */
export interface QueuePrincipal {
  sessionId: string | null
  issueId: string | null
  label: string
}

export interface ActiveQueueLease extends QueuePrincipal {
  acquiredAt: string
  expiresAt: string
  secondsLeft: number
  note: string | null
}

export interface QueueWaiter extends QueuePrincipal {
  position: number
  enqueuedAt: string
}

export interface QueueLock {
  /** The lock's name, free-form apart from the reserved `merge:` namespace. */
  name: string
  holder: ActiveQueueLease
  queue: QueueWaiter[]
}

/**
 * The panel's deliberately small data seam. Transport adapts to this union.
 *
 * One reading covers the WHOLE repository: `lock.status` without a name answers
 * with every lease, so loading and failure are properties of the panel rather
 * than of each queue. A lock has a row only while it is held — an absent name
 * means that lease is free, not that it is unknown.
 */
export type QueuePanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      locks: readonly QueueLock[]
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
  lock: QueueLock | null,
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

/**
 * What a lease IS, which is what the group's icon and vocabulary come from —
 * not where it sits. A merge mutex on another branch is still a merge queue
 * even though only `merge:main` is pinned. `other` is every lease an agent took
 * under a name nobody registered in advance — the whole point of reading the
 * repository rather than a fixed list.
 */
export type QueueGroupKind = 'merge' | 'heavy' | 'other'

export function lockGroupKind(name: string): QueueGroupKind {
  if (isMergeLockName(name)) return 'merge'
  if (name === HEAVY_TEST_LOCK_NAME || name.startsWith('test:')) return 'heavy'
  return 'other'
}

export interface QueueGroupModel {
  name: string
  kind: QueueGroupKind
  title: string
  /** Section label over the holder, in the group's own vocabulary. */
  activeLabel: string
  /** `null` for a pinned lane nobody holds right now. */
  lock: QueueLock | null
}

/**
 * A human title for a lock name. The two known lanes keep their product names;
 * anything else is the name itself, made readable — `validation:admission`
 * reads as "Validation admission". Guessing a friendlier name would be worse
 * than showing the operator the string they will type into `podium lock`.
 */
export function lockGroupTitle(name: string): string {
  if (name === MERGE_LOCK_NAME) return 'Merge queue'
  if (name === HEAVY_TEST_LOCK_NAME) return 'Heavy test queue'
  // A merge mutex on another branch is still a merge queue — say which branch.
  if (isMergeLockName(name)) return `Merge queue (${name.slice(MERGE_LOCK_PREFIX.length)})`

  const words = name
    .split(/[:/_-]+/)
    .filter(Boolean)
    .join(' ')
  if (words.length === 0) return name
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Section label over the holder — what holding THIS lease means. */
const ACTIVE_LABEL: Record<QueueGroupKind, string> = {
  merge: 'MERGING NOW',
  heavy: 'TESTING NOW',
  other: 'HOLDING NOW',
}

function groupFor(name: string, lock: QueueLock | null): QueueGroupModel {
  const kind = lockGroupKind(name)
  return { name, kind, title: lockGroupTitle(name), activeLabel: ACTIVE_LABEL[kind], lock }
}

export interface QueueGroups {
  merge: QueueGroupModel
  heavy: QueueGroupModel
  /** Every other held lease, by name. */
  others: QueueGroupModel[]
}

/**
 * The groups to render: the merge queue, the heavy-test queue, then every other
 * held lease by name.
 *
 * The two known lanes are pinned even when free — the merge lane still lists
 * what is ready to merge, and both are lanes the operator expects to find in a
 * fixed place. Every other lease appears only while held, because a free lock
 * has no row to report and no name to guess.
 */
export function queueGroups(locks: readonly QueueLock[]): QueueGroups {
  const byName = new Map(locks.map((lock) => [lock.name, lock] as const))

  return {
    merge: groupFor(MERGE_LOCK_NAME, byName.get(MERGE_LOCK_NAME) ?? null),
    heavy: groupFor(HEAVY_TEST_LOCK_NAME, byName.get(HEAVY_TEST_LOCK_NAME) ?? null),
    others: locks
      .filter((lock) => lock.name !== MERGE_LOCK_NAME && lock.name !== HEAVY_TEST_LOCK_NAME)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((lock) => groupFor(lock.name, lock)),
  }
}

export function formatLeaseRemaining(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const remainder = safe % 60
  if (minutes === 0) return `${remainder}s`
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`
}
