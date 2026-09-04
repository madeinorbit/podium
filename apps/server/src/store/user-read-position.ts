/**
 * EVENT-STREAM READ POSITIONS AT REST, KEYED BY USER (POD-1380).
 *
 * ---------------------------------------------------------------------------
 * EVERY METHOD TAKES A USER. THERE IS NO METHOD THAT DOES NOT.
 * ---------------------------------------------------------------------------
 * Same posture as {@link UserLayoutRepository} and its preference sibling: no
 * bulk cross-user read exists to be called by accident. A second person on the
 * same device sees nothing of the first, and the reason is structural rather than
 * a check every caller has to remember — there is no query here that could return
 * another user's row.
 *
 * ---------------------------------------------------------------------------
 * THE MONOTONIC MERGE LIVES IN THE MODEL, NOT IN SQL
 * ---------------------------------------------------------------------------
 * {@link UserReadPositionRepository.advance} reads, asks `@podium/model`'s
 * `advanceReadPosition`, and writes only when the position actually moves. It is
 * deliberately NOT `MAX(excluded.last_event_id, last_event_id)` in an upsert: the
 * rule is the command's declared conflict rule, it has to be readable by the
 * client too, and two spellings of one arbitration rule is how they drift. The
 * read and the write share a transaction so a concurrent advance cannot land
 * between them.
 *
 * WHICH FEEDS ARE ADMISSIBLE IS THE MODEL'S ANSWER. `advance` refuses a feed
 * `isReadStreamId` does not admit, so a mis-routed key cannot grow a row here
 * even if the command schema is bypassed.
 */

import {
  advanceReadPosition,
  isReadStreamId,
  type ReadPositionSnapshot,
  type UserId,
} from '@podium/model'
import { and, eq } from 'drizzle-orm'
import { userReadPosition } from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'

/** One stored position. `undefined` from a reader means "never read this stream". */
export interface StoredReadPosition {
  readonly lastEventId: number
  readonly seenAt: string | null
}

export class UserReadPositionRepository {
  private readonly rootDb: SyncDrizzle
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

  /** One person's position in every stream they have read. Absent key = never. */
  getSnapshot(userId: UserId): ReadPositionSnapshot {
    const rows = this.db
      .select({
        streamId: userReadPosition.streamId,
        lastEventId: userReadPosition.lastEventId,
        seenAt: userReadPosition.seenAt,
      })
      .from(userReadPosition)
      .where(eq(userReadPosition.userId, userId))
      .all()
    const out: Record<string, StoredReadPosition> = {}
    for (const row of rows) {
      // A feed retired from the vocabulary stops being reported rather than
      // being rendered as an unknown stream the client cannot place.
      if (!isReadStreamId(row.streamId)) continue
      out[row.streamId] = { lastEventId: row.lastEventId, seenAt: row.seenAt }
    }
    return out
  }

  /** One stream's position for one person, or `undefined` when never read. */
  get(userId: UserId, streamId: string): StoredReadPosition | undefined {
    const row = this.db
      .select({
        lastEventId: userReadPosition.lastEventId,
        seenAt: userReadPosition.seenAt,
      })
      .from(userReadPosition)
      .where(and(eq(userReadPosition.userId, userId), eq(userReadPosition.streamId, streamId)))
      .get()
    return row === undefined ? undefined : { lastEventId: row.lastEventId, seenAt: row.seenAt }
  }

  /**
   * Move one person's position forward. Returns the stored position when it
   * MOVED, or `null` when the proposal was at or behind it (a no-op, so the
   * caller publishes nothing).
   *
   * THROWS on a feed outside the closed vocabulary — a mis-routed key must not
   * grow a server row.
   */
  advance(
    userId: UserId,
    streamId: string,
    proposed: StoredReadPosition,
    updatedAt: string,
  ): StoredReadPosition | null {
    if (!isReadStreamId(streamId)) {
      throw new Error(
        `'${streamId}' is not a known event stream (POD-1380 / isReadStreamId), so it has no cursor row`,
      )
    }
    return this.createOrJoinTransaction(() => {
      const current = this.get(userId, streamId)
      const next = advanceReadPosition(current, {
        lastEventId: proposed.lastEventId,
        seenAt: proposed.seenAt,
      })
      if (next === null) return null
      // `INSERT OR REPLACE` -> `onConflictDoUpdate` on the composite primary
      // key. `user_read_position` has that one uniqueness constraint and the
      // insert names all five columns, so the two forms agree (POD-3403).
      const values = {
        userId,
        streamId,
        lastEventId: next.lastEventId,
        seenAt: next.seenAt,
        updatedAt,
      }
      this.db
        .insert(userReadPosition)
        .values(values)
        .onConflictDoUpdate({
          target: [userReadPosition.userId, userReadPosition.streamId],
          set: values,
        })
        .run()
      return next
    })
  }
}
