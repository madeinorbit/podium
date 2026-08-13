import {
  groupIssuesByStage as coreGroupIssuesByStage,
  flattenStageGroups,
} from '@podium/client-core/viewmodels'
import type { IssueStage } from '@podium/model/browser'
import type { IssueViewModel } from '@/app/store'
import type { IssuesOrdering } from './issues-display'

/**
 * Stage grouping for the board, typed for this app. The derivation moved to
 * `@podium/client-core/viewmodels/issue-board-rows` (POD-724) so the phone's
 * Tasks tab groups and orders identically; these are the `IssueViewModel`-shaped
 * signatures the existing call sites already use.
 */

/** Group active issues into all six lifecycle stages (board parity: every stage
 *  is present even when empty), each group internally ordered by `ordering`. */
export function groupIssuesByStage(
  issues: IssueViewModel[],
  ordering: IssuesOrdering,
): { stage: IssueStage; issues: IssueViewModel[] }[] {
  return coreGroupIssuesByStage(issues, ordering)
}

/** Flatten grouped issues into their ids in visual (top-to-bottom) order —
 *  the basis for prev/next navigation and list keyboard movement. */
export function flattenGroups(groups: { issues: IssueViewModel[] }[]): string[] {
  return flattenStageGroups(groups)
}
