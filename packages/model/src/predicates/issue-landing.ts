/**
 * Issue landing and merge verdicts: whether an issue's work was abandoned,
 * awaits a merge, or landed. Display rules read by the sidebar, the flight
 * deck and the state words; they decide nothing about what the device holds
 * (the policy and the collections do, `records/declarations.ts`).
 */

import {
  canonicalIssueCloseReason,
  type IssueStatusFields,
  issueStatusOf,
} from '../entities/issue-status'
import { isClosed, isFinished } from './issue-lifecycle'

/** Cancelled, duplicate and superseded work contributes no remaining progress. */
export function issueAbandoned(issue: {
  readonly stage?: unknown
  readonly closedReason?: unknown
}): boolean {
  const reason = canonicalIssueCloseReason(issue.closedReason)
  const status = reason ?? (isClosed(issue) ? 'done' : issue.stage)
  return status === 'cancelled' || status === 'duplicate' || status === 'superseded'
}

/**
 * The most the merge verdict reads of an issue row: the finished and blocked
 * standing, the close reason (abandoned closures ask nothing), and the
 * checkout's merge axis. Structural so a frozen slice row (`SliceIssue`,
 * which does not spell `branch`/`gitState`) still answers it: the pool's
 * composed row carries the wire's fields at runtime
 * (`row-source.ts:84`, the wire cast).
 */
export interface MergeVerdictRow {
  readonly stage?: unknown
  readonly closedReason?: unknown
  readonly blocked?: unknown
  readonly branch?: unknown
  readonly gitState?: unknown
}

/**
 * `issuePendingDecision` (`slices/issues.ts:391-404`) without the review
 * fallback: a finished, non-abandoned issue whose private branch holds
 * unlanded work (`issueHasUnmergedDelivery`, `slices/issues.ts:357-367`).
 * R-VIS keeps such a row without limit (`rows.ts:95-104`,
 * `visibility.ts:31-32`).
 */
export function awaitingMergeOf(row: MergeVerdictRow): boolean {
  const finished = isFinished(row)
  if (!finished) return false
  if (issueAbandoned(row)) return false
  return unmergedDeliveryOf(row)
}

/** Private unlanded commits, including a review-stage deliverable. */
export function unmergedDeliveryOf(row: MergeVerdictRow): boolean {
  const git = row.gitState as
    | { shared?: unknown; merged?: unknown; ahead?: unknown }
    | null
    | undefined
  return (
    typeof row.branch === 'string' &&
    row.branch.length > 0 &&
    git != null &&
    git.shared === false &&
    git.merged !== true &&
    typeof git.ahead === 'number' &&
    git.ahead > 0
  )
}

/** Where and what the merge action landed, for a done row it stamped. */
export interface IssueLanding {
  at: string
  branch: string | null
  /** The landed tip, abbreviated to seven characters; null when unread. */
  sha: string | null
}

/**
 * The landing a done row records, or null (POD-2151). Only `done`, and only
 * while nothing awaits merge: the stamp outlives a reopen, so unlanded work
 * outranks it.
 */
export function issueLanding(
  row: IssueStatusFields &
    MergeVerdictRow & {
      readonly landedAt?: string | null
      readonly landedSha?: string | null
      readonly parentBranch?: string | null
    },
): IssueLanding | null {
  if (!row.landedAt || issueStatusOf(row) !== 'done' || unmergedDeliveryOf(row)) return null
  return {
    at: row.landedAt,
    branch: row.parentBranch || null,
    sha: row.landedSha ? row.landedSha.slice(0, 7) : null,
  }
}
