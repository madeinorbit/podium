/** The pool and client-core share the model's scalar lifecycle rules. */
export { isFinished, isClosed, isExcluded } from '@podium/model/browser'

import { canonicalIssueCloseReason, isClosed } from '@podium/model/browser'

/** Cancelled, duplicate and superseded work contributes no remaining progress. */
export function issueAbandoned(issue: { readonly stage?: unknown; readonly closedReason?: unknown }): boolean {
  const reason = canonicalIssueCloseReason(issue.closedReason)
  const status = reason ?? (isClosed(issue) ? 'done' : issue.stage)
  return status === 'cancelled' || status === 'duplicate' || status === 'superseded'
}
