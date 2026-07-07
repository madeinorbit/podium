/**
 * Migration 003 — missing indexes flagged by the store audit (free hardening,
 * no semantic change):
 *
 *  - `issues.parent_id`: the subtree walk (childrenOf / tree assembly) and the
 *    dangling-parent scrub on delete filter by parent_id — table scans before.
 *  - `podium_events.repo_path`: listEventsSince supports a repo_path filter
 *    (steward per-repo polling) — only `kind` was indexed.
 */

import type { SqlDatabase } from '@podium/core/sqlite'

export function up(db: SqlDatabase): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_podium_events_repo ON podium_events(repo_path)')
}
