/**
 * Migration 016 — add issues.color [spec:SP-b4d1] (issue #38).
 *
 * The user-assigned colour SLOT NAME ('rose' … 'lime', the 10-entry palette in
 * @podium/domain) — never a hex; the palette maps slots to full colouring
 * schemes client-side. NULL = no colour = the neutral slate flow, so no
 * backfill is needed. Idempotent: skips if the column already exists.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!cols.has('color')) {
    db.exec('ALTER TABLE issues ADD COLUMN color TEXT')
  }
}
