/** Scalar issue lifecycle rules shared by every client and the server. */
export interface IssueLifecycleFacts {
  readonly stage?: unknown
  readonly closedReason?: unknown
  readonly archived?: unknown
  readonly deletedAt?: unknown
}

/** A recorded close reason, including an empty string. Null and undefined are absent. */
export function isClosed(issue: Pick<IssueLifecycleFacts, 'closedReason'>): boolean {
  return issue.closedReason != null
}

/** Finished by board stage or an explicit close reason. */
export function isFinished(issue: IssueLifecycleFacts): boolean {
  return issue.stage === 'done' || isClosed(issue)
}

/** Issues excluded from the worklist regardless of seats or selection. */
export function isExcluded(issue: IssueLifecycleFacts): boolean {
  return issue.archived === true || issue.deletedAt != null ||
    issue.stage === 'proposed' || issue.stage === 'shipping'
}
