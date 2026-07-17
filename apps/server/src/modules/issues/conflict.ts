/**
 * Issue-tracker CONCURRENCY enforcement — the server half of the pure
 * `checkExpectedRevision` decision in @podium/domain, split exactly as
 * `authorize` / `checkIssueAccess` are: the decision is pure, the throw is
 * transport-shaped.
 *
 * ADR 3 D13.3: a stale `expectedRevision` is an authority **`rejected`** —
 * definitive, structured, and SURFACED. Never a silent overwrite (which would
 * lose the other writer's work) and never a silent drop (D9's forbidden
 * poison-drop). The current revision rides on the rejection so a caller can
 * rebase onto truth instead of guessing.
 */

import { checkExpectedRevision, type RevisionCheck } from '@podium/domain'
import { TRPCError } from '@trpc/server'

/** The renderable facts of a refused precondition (ADR 3 D13.3). */
export interface IssueRevisionConflictDetail {
  issueId: string
  /** The command whose precondition failed, dotted (`issues.update`). */
  command: string
  expectedRevision: number
  /** The authority's current revision — absent when the entity carries none
   *  (`unverifiable`), which is why this is not simply a number. */
  actualRevision?: number
  reason: 'stale-revision' | 'revision-unavailable'
}

/**
 * The structured cause carried on the CONFLICT TRPCError. tRPC does not
 * serialize `cause`, so the router's errorFormatter (apps/server/src/trpc.ts)
 * reads this and lifts `detail` onto `error.data.conflict` — that is what makes
 * the rejection machine-readable at a real client rather than a message a human
 * has to parse.
 */
export class IssueRevisionConflict extends Error {
  constructor(readonly detail: IssueRevisionConflictDetail) {
    super(describeConflict(detail))
    this.name = 'IssueRevisionConflict'
  }
}

function describeConflict(d: IssueRevisionConflictDetail): string {
  if (d.reason === 'revision-unavailable') {
    return (
      `${d.command} expected revision ${d.expectedRevision} of issue ${d.issueId}, but that ` +
      `issue carries no revision to check against (a hub-mirrored issue, or one written ` +
      `before revisions existed) — the precondition cannot be honoured, so the write was refused`
    )
  }
  return (
    `${d.command} expected revision ${d.expectedRevision} of issue ${d.issueId}, but it is at ` +
    `revision ${d.actualRevision} — the issue changed since you read it. Re-read it and retry.`
  )
}

/**
 * Enforce a command's expected-revision precondition, throwing the definitive
 * CONFLICT (HTTP 409) on a refusal. `ok` returns silently.
 */
export function enforceExpectedRevision(args: {
  command: string
  issueId: string
  expected: number | undefined
  actual: number | undefined
}): void {
  const check: RevisionCheck = checkExpectedRevision(args.expected, args.actual)
  if (check.kind === 'ok') return
  const detail: IssueRevisionConflictDetail =
    check.kind === 'stale'
      ? {
          issueId: args.issueId,
          command: args.command,
          expectedRevision: check.expected,
          actualRevision: check.actual,
          reason: 'stale-revision',
        }
      : {
          issueId: args.issueId,
          command: args.command,
          expectedRevision: check.expected,
          reason: 'revision-unavailable',
        }
  const cause = new IssueRevisionConflict(detail)
  throw new TRPCError({ code: 'CONFLICT', message: cause.message, cause })
}
