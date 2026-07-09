/**
 * Migration 009 — add issues.audience (#198).
 *
 * `audience` is the second provenance axis, parallel to `origin`: `origin` is WHO
 * CREATED the issue (deterministic, caller-derived), `audience` is WHO IT IS FOR.
 * The board filters on `audience` — only `audience = 'human'` shows at the top
 * level; `audience = 'agent'` is the agent's internal working detail, nested under
 * its nearest human-audience ancestor.
 *
 * Backfill: seed `audience` FROM `origin` (both are 'human' | 'agent'), so the
 * board's audience filter reproduces the old origin filter exactly on existing
 * data — a row hidden before (origin 'agent') stays hidden (audience 'agent'), and
 * a visible one stays visible. Nothing disappears AND nothing newly appears;
 * behavior changes only for NEW creates (agent creates default to 'agent' via the
 * command layer). The column default 'human' only covers the add-column moment
 * before the UPDATE. Idempotent: skips both steps if the column already exists (a
 * DB that ran a newer inline DDL).
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!cols.has('audience')) {
    db.exec("ALTER TABLE issues ADD COLUMN audience TEXT NOT NULL DEFAULT 'human'")
    db.exec("UPDATE issues SET audience = origin WHERE origin IN ('human', 'agent')")
  }
}
