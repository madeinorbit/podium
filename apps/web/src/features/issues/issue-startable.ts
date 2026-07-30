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

import type { IssueWire } from '@podium/model'
/**
 * Composed from `IssueWire` rather than restated (POD-367) — the field NAMES and
 * their base types have one home.
 *
 * Every member is `| null` on top of the aggregate's type ON PURPOSE, and that is
 * why this is a mapped type rather than a plain `Partial<Pick<…>>`: this is a
 * STRUCTURAL predicate port (ADR 4 R5), and it must be satisfiable by an
 * `IssueRow` (storage, where a cleared field is `null`) as well as by an
 * `IssueWire` (wire, where a cleared field is absent). Narrowing to the wire's
 * exact types would quietly exclude every row-shaped caller.
 */
type StartabilityFields<K extends keyof IssueWire> = { [P in K]?: IssueWire[P] | null }

export type StartableIssueLike = StartabilityFields<
  'worktreePath' | 'closedReason' | 'archived' | 'deletedAt'
>

export function isIssueStartable(issue: StartableIssueLike): boolean {
  return !issue.worktreePath && issue.closedReason == null && !issue.archived && !issue.deletedAt
}
