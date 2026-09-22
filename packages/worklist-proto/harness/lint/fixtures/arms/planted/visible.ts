import type { Pool } from './store'

/** The one enumeration module: the visible-set builder may walk a table. */
export function visibleIds(pool: Pool): string[] {
  const out: string[] = []
  for (const issue of pool.issues.values()) if (issue.parentId == null) out.push(issue.id)
  return out
}
