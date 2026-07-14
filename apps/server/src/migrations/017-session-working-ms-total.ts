/** Migration 017 — persist the completed agent compute total used by motion timers.
 *
 * NULL is intentional: it distinguishes legacy/old-daemon sessions with no
 * cumulative timing data from a measured zero. Idempotent for convergence and
 * partially-upgraded development databases.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!cols.has('working_ms_total')) {
    db.exec('ALTER TABLE sessions ADD COLUMN working_ms_total INTEGER')
  }
}
