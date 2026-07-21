/**
 * Startability gate for the "Run now" quick actions (POD-110): the ref
 * miniview, the peek drawer, and the row context menu all offer a one-click
 * agent start, and they must agree on when it applies.
 *
 * Startable ⇔ no worktree yet (the canonical "already started / live agent"
 * proxy — same gate the full page and `workflow.start()` use) and the issue is
 * still live (not closed, archived, or deleted). Structural subset so the
 * miniview's `RefIssueLike` rows fit alongside full `IssueWire` rows.
 */
export interface StartableIssueLike {
  worktreePath?: string | null
  closedReason?: string | null
  archived?: boolean
  deletedAt?: string | null
}

export function isIssueStartable(issue: StartableIssueLike): boolean {
  return !issue.worktreePath && issue.closedReason == null && !issue.archived && !issue.deletedAt
}
