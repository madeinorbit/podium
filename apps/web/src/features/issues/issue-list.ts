import { ISSUE_STAGES, type IssueStage, type IssueWire } from '@podium/protocol'
import { type IssuesOrdering, orderIssues } from './issues-display'

/** Group active issues into all six lifecycle stages (board parity: every stage
 *  is present even when empty), each group internally ordered by `ordering`. */
export function groupIssuesByStage(
  issues: IssueWire[],
  ordering: IssuesOrdering,
): { stage: IssueStage; issues: IssueWire[] }[] {
  return ISSUE_STAGES.map((stage) => ({
    stage,
    issues: orderIssues(
      issues.filter((i) => i.stage === stage),
      ordering,
    ),
  }))
}

/** Flatten grouped issues into their ids in visual (top-to-bottom) order —
 *  the basis for prev/next navigation and list keyboard movement. */
export function flattenGroups(groups: { issues: IssueWire[] }[]): string[] {
  return groups.flatMap((g) => g.issues.map((i) => i.id))
}
