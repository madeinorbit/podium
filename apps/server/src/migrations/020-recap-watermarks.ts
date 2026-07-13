import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * Read toolkit tier 3 (#237) [spec:SP-34d7 read-toolkit]: per-(reader, target
 * session) recap watermarks. `podium session recap` summarizes a session's
 * transcript SINCE a watermark and persists the new one here, so a parent
 * polling its child pays only for the delta on every check-in — across server
 * restarts and without the caller having to thread --since itself.
 */
export function up(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recap_watermarks (
      reader     TEXT NOT NULL,
      session_id TEXT NOT NULL,
      watermark  TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (reader, session_id)
    )
  `)
}
