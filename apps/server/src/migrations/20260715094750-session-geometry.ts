/**
 * Migration 20260715094750 — session-geometry.
 *
 * ADDITIVE ONLY: no destructive drops/renames in a single release (two-phase them).
 * Runs inside a transaction — do NOT BEGIN/COMMIT here.
 * Must be ORDER-INDEPENDENT: a back-filled migration can run after higher-numbered
 * ones, so do not assume a predecessor already ran — guard defensively instead.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name),
  )
  if (!cols.has('terminal_cols')) {
    db.exec('ALTER TABLE sessions ADD COLUMN terminal_cols INTEGER NOT NULL DEFAULT 80')
  }
  if (!cols.has('terminal_rows')) {
    db.exec('ALTER TABLE sessions ADD COLUMN terminal_rows INTEGER NOT NULL DEFAULT 24')
  }
}
