/**
 * Transport-shaped issue revision conflicts produced from the sync Authority's
 * definitive arbitration rejection. There is no comparison here: current state
 * and the attempted precondition have already been decided atomically by the
 * kernel.
 */

import type { ArbitrationRejection } from '@podium/sync'
import { TRPCError } from '@trpc/server'

export interface IssueRevisionConflictDetail {
  issueId: string
  /** The command whose precondition failed, dotted (for example issues.update). */
  command: string
  expectedRevision: number
  actualRevision?: number
  reason: 'stale-revision' | 'revision-unavailable'
}

/**
 * The structured cause carried on the CONFLICT TRPCError. The router error
 * formatter lifts detail onto error.data.conflict for real clients.
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
      `issue carries no revision to check against - the precondition cannot be honoured, so ` +
      `the write was refused`
    )
  }
  return (
    `${d.command} expected revision ${d.expectedRevision} of issue ${d.issueId}, but it is at ` +
    `revision ${d.actualRevision} - the issue changed since you read it. Re-read it and retry.`
  )
}

/** Surface an Authority exp-rev rejection as the existing structured 409. */
export function throwIssueRevisionConflict(args: {
  command: string
  issueId: string
  expectedRevision: number | undefined
  actualRevision: number | undefined
  rejection: ArbitrationRejection
}): never {
  if (args.rejection !== 'revision-mismatch') {
    throw new Error(
      `issues exp-rev arbitration rejected with unexpected reason ${args.rejection}`,
    )
  }
  if (args.expectedRevision === undefined) {
    throw new Error('issues exp-rev arbitration rejected an omitted revision despite compatibility')
  }
  const detail: IssueRevisionConflictDetail =
    args.actualRevision === undefined
      ? {
          issueId: args.issueId,
          command: args.command,
          expectedRevision: args.expectedRevision,
          reason: 'revision-unavailable',
        }
      : {
          issueId: args.issueId,
          command: args.command,
          expectedRevision: args.expectedRevision,
          actualRevision: args.actualRevision,
          reason: 'stale-revision',
        }
  const cause = new IssueRevisionConflict(detail)
  throw new TRPCError({ code: 'CONFLICT', message: cause.message, cause })
}
