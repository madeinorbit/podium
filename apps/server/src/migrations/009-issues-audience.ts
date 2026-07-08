/**
 * Migration 009 — add issues.audience (#198).
 *
 * `audience` is the second provenance axis, parallel to `origin`: `origin` is WHO
 * CREATED the issue (deterministic, caller-derived), `audience` is WHO IT IS FOR.
 * The board filters on `audience` — only `audience = 'human'` shows at the top
 * level; `audience = 'agent'` is the agent's internal working detail, nested under
 * its nearest human-audience ancestor.
 *
 * Backfill: the column default `'human'` fills every existing row, so nothing
 * disappears from the board on upgrade — behavior changes only for NEW creates
 * (agent creates default to 'agent' via the command layer). Idempotent: skips the
 * ALTER if the column already exists (a DB that ran a newer inline DDL).
 */

import type { SqlDatabase } from '@podium/core/sqlite'

export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!cols.has('audience')) {
    db.exec("ALTER TABLE issues ADD COLUMN audience TEXT NOT NULL DEFAULT 'human'")
  }
}
