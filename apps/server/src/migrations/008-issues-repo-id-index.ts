/**
 * Migration 008 — non-unique index on issues.repo_id (#140, ported from main's
 * inline migrate()).
 *
 * repo_id is the identity/scoping key: seq allocation (nextIssueSeq), repo-scoped
 * listing (inRepoScope) and #N resolution all filter on it. Migration 005 added
 * UNIQUE(repo_id, seq) — which serves prefix lookups on repo_id too — but main
 * shipped a dedicated `idx_issues_repo_id ON issues(repo_id)`, so databases that
 * ran main's inline DDL already contain it. Recreating it here (IF NOT EXISTS)
 * keeps both lineages byte-converged on sqlite_master.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_repo_id ON issues(repo_id)')
}
