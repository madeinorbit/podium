/**
 * Recap watermarks aggregate (#237) [spec:SP-34d7 read-toolkit tier 3] — one
 * row per (reader, target session): the transcript cursor the reader's last
 * `podium session recap` caught up to. Persisted so repeated check-ins pay
 * only for the delta, across restarts, without the caller threading --since.
 */

import type { SessionId } from '@podium/model'
import { and, eq, sql } from 'drizzle-orm'
import type { ReaderRef } from '../modules/sessions/read-toolkit'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].

const recapWatermarkOf = prepared((db, t) =>
  db
    .select({ watermark: t.recapWatermarks.watermark })
    .from(t.recapWatermarks)
    .where(
      and(
        eq(t.recapWatermarks.reader, param(t.recapWatermarks.reader, 'reader')),
        eq(t.recapWatermarks.sessionId, param(t.recapWatermarks.sessionId, 'sessionId')),
      ),
    )
    .prepare(),
)

const upsertRecapWatermark = prepared((db, t) =>
  db
    .insert(t.recapWatermarks)
    .values({
      reader: sql.placeholder('reader'),
      sessionId: sql.placeholder('sessionId'),
      watermark: sql.placeholder('watermark'),
      updatedAt: sql.placeholder('at'),
    })
    .onConflictDoUpdate({
      target: [t.recapWatermarks.reader, t.recapWatermarks.sessionId],
      set: { watermark: sql.placeholder('watermark'), updatedAt: sql.placeholder('at') },
    })
    .prepare(),
)

export class ReadWatermarksRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db() {
    return this.rootDb
  }

  /** `null` and not `undefined` when absent: the caller distinguishes the two,
   *  and `read-watermarks.test.ts` pins it. */
  async getRecapWatermark(reader: ReaderRef, sessionId: SessionId): Promise<string | null> {
    const row = await recapWatermarkOf(this.db).get({ reader, sessionId })
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
  async setRecapWatermark(
    reader: ReaderRef,
    sessionId: SessionId,
    watermark: string,
    at: string,
  ): Promise<void> {
    await upsertRecapWatermark(this.db).run({ reader, sessionId, watermark, at })
  }
}
