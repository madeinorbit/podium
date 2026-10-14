import type { IssueRow } from './store'

/** Template-completeness findings for one issue, by type. Empty = clean. */
export function lintIssue(
  row: Pick<IssueRow, 'title' | 'description' | 'acceptance' | 'type'>,
): string[] {
  const out: string[] = []
  if (!row.title?.trim()) out.push('missing title')
  const hasAcc = !!row.acceptance && row.acceptance.trim().length > 0
  // Types narrowed to task | phase | decision (POD-6106); the bug/epic templates
  // went with them. The whole lint is retired by POD-6094.
  if (row.type === 'task' && !hasAcc) out.push('missing acceptance criteria')
  return out
}
