import type { IssueNavigationModel } from '../issues'

/** The timestamp Closed presents and sorts by. A manual tuck owns that history;
 * cancelled and age-folded rows have no tuck stamp, so their finish time remains
 * the honest fallback instead of manufacturing one. */
export function issueClosedFoldAt(
  issue: Pick<IssueNavigationModel, 'tuckedAt' | 'closedAt' | 'updatedAt'>,
): string {
  return issue.tuckedAt ?? issue.closedAt ?? issue.updatedAt
}
