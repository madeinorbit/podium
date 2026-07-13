/**
 * Recap watermarks aggregate (#237) [spec:SP-34d7 read-toolkit tier 3] — one
 * row per (reader, target session): the transcript cursor the reader's last
 * `podium session recap` caught up to. Persisted so repeated check-ins pay
 * only for the delta, across restarts, without the caller threading --since.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export class ReadWatermarksRepository {
  constructor(private readonly db: SqlDatabase) {}

  getRecapWatermark(reader: string, sessionId: string): string | null {
    const r = this.db
      .prepare('SELECT watermark FROM recap_watermarks WHERE reader = ? AND session_id = ?')
      .get(reader, sessionId) as { watermark: string } | undefined
    return r?.watermark ?? null
  }

  setRecapWatermark(reader: string, sessionId: string, watermark: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO recap_watermarks (reader, session_id, watermark, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (reader, session_id) DO UPDATE SET watermark = excluded.watermark,
           updated_at = excluded.updated_at`,
      )
      .run(reader, sessionId, watermark, at)
  }
}
