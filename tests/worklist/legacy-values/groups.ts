import { issueClosedFoldAt, rowInClosedFold, rowInSnoozedFold, type UnifiedWorkGroup, type UnifiedWorkRow } from '@podium/client-core/values'
import type { IssueId } from '@podium/model'

/**
 * Bucket unified WORK rows by repo (stable repoId when known, repoPath
 * otherwise — so the same repo on two machines/paths merges into one group).
 * Open-row and group order follow the incoming fixed creation order. Closed
 * rows deliberately ignore manual sort keys: the fold is a small history list,
 * ordered by the moment of tucking (or finishing when never tucked), newest first.
 */
export function groupUnifiedWorkRows(
  rows: UnifiedWorkRow[],
  selectedIssueId: IssueId | null = null,
  selectedIssueWasFolded = false,
  now: number = Date.now(),
): UnifiedWorkGroup[] {
  const groups: UnifiedWorkGroup[] = []
  const byKey = new Map<string, UnifiedWorkGroup>()
  for (const row of rows) {
    const key =
      row.kind === 'issue'
        ? (row.issue.repoId ?? row.issue.repoPath)
        : (row.worktree.repoId ?? row.worktree.repoPath)
    let group = byKey.get(key)
    if (!group) {
      const label =
        row.kind === 'worktree'
          ? row.worktree.repoName
          : row.issue.repoPath.split('/').pop() || row.issue.repoPath
      group = { key, label, rows: [], snoozedRows: [], closedRows: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    if (rowInClosedFold(row, selectedIssueId, selectedIssueWasFolded, now)) {
      group.closedRows.push(row)
    } else if (rowInSnoozedFold(row, now)) {
      group.snoozedRows.push(row)
    } else group.rows.push(row)
  }
  for (const group of groups) {
    group.closedRows.sort(
      (a, b) =>
        (Date.parse(issueClosedFoldAt(b.issue)) || 0) -
        (Date.parse(issueClosedFoldAt(a.issue)) || 0),
    )
  }
  return groups
}
