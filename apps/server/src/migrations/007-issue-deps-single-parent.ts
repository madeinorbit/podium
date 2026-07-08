/**
 * Migration 007 — single-source parent storage (issue #164 step 3).
 *
 * The parent/child hierarchy used to be stored TWICE: issues.parent_id (the
 * column) and a mirrored 'parent-child' edge in issue_deps, kept in sync by
 * setParent. Dual storage invited divergence (and needed guard code in
 * addDep/removeDep plus a boot-time repair). issues.parent_id is now the only
 * storage; graph/tree/cycle consumers synthesize the edge from the column.
 * This migration deletes the redundant edge rows — parent_id already carries
 * the same information on every row (setParent always wrote both).
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  db.exec("DELETE FROM issue_deps WHERE type = 'parent-child'")
}
