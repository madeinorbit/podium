import type { IssueRow } from './store'

/** Template-completeness findings for one issue, by type. Empty = clean. */
export function lintIssue(
  row: Pick<IssueRow, 'title' | 'description' | 'acceptance' | 'type'>,
): string[] {
  const out: string[] = []
  if (!row.title?.trim()) out.push('missing title')
  const hasDesc = !!row.description && row.description.trim().length > 0
  const hasAcc = !!row.acceptance && row.acceptance.trim().length > 0
  if (row.type === 'bug') {
    if (!hasDesc) out.push('bug missing reproduction (description)')
    if (!hasAcc) out.push('bug missing acceptance criteria')
  } else if (row.type === 'task' || row.type === 'feature') {
    if (!hasAcc) out.push('missing acceptance criteria')
  } else if (row.type === 'epic') {
    if (!hasDesc) out.push('epic missing description')
  }
  return out
}
