/**
 * Recap watermarks aggregate (#237) [spec:SP-34d7 read-toolkit tier 3] — one
 * row per (reader, target session): the transcript cursor the reader's last
 * `podium session recap` caught up to. Persisted so repeated check-ins pay
 * only for the delta, across restarts, without the caller threading --since.
 */

import type { SessionId } from '@podium/model'
import { and, eq } from 'drizzle-orm'
import { recapWatermarks } from '../migrations/schema'
import type { ReaderRef } from '../modules/sessions/read-toolkit'
import type { SyncQueries } from './executor/sync-drizzle'

export class ReadWatermarksRepository {
  constructor(private readonly queries: SyncQueries) {}

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db() {
    return this.queries.db
  }

  /** `null` and not `undefined` when absent: the caller distinguishes the two,
   *  and `read-watermarks.test.ts` pins it. */
  getRecapWatermark(reader: ReaderRef, sessionId: SessionId): string | null {
    const row = this.db
      .select({ watermark: recapWatermarks.watermark })
      .from(recapWatermarks)
      .where(and(eq(recapWatermarks.reader, reader), eq(recapWatermarks.sessionId, sessionId)))
      .get()
    return row?.watermark ?? null
  }

  /**
   * Upsert on the (reader, session_id) pair.
   *
   * Already an `ON CONFLICT … DO UPDATE` before the conversion, so this is a
   * transcription rather than a form change — and `recap_watermarks` has one
   * uniqueness constraint, that composite primary key, so the target is
   * unambiguous. `updated_at` is in the `set` because it was in the original
   * `DO UPDATE SET`; nothing reads it back through this repository, so its
   * golden test reads it off the table.
   */
  setRecapWatermark(reader: ReaderRef, sessionId: SessionId, watermark: string, at: string): void {
    this.db
      .insert(recapWatermarks)
      .values({ reader, sessionId, watermark, updatedAt: at })
      .onConflictDoUpdate({
        target: [recapWatermarks.reader, recapWatermarks.sessionId],
        set: { watermark, updatedAt: at },
      })
      .run()
  }
}
