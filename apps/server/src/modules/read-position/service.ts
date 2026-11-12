/**
 * Feed-cursor service (POD-1380) — read/advance the calling principal's read
 * positions and publish each MOVE onto the Authority change log so a second
 * device of the same user receives the row.
 *
 * PUBLISHES ONLY WHEN THE CURSOR MOVED. `advance` returns null for a proposal at
 * or behind the stored position, and a no-op must not become a feed row: the
 * feed is how one person's other devices learn the position, and a row that
 * carries no change is indistinguishable to them from one that does.
 */

import { readPositionRowId, type UserId } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'
import type { StoredReadPosition, UserReadPositionRepository } from '../../store/user-read-position'

export interface ReadPositionServiceDeps {
  readonly cursors: UserReadPositionRepository
}

/** What a read mark is written through: the generic edit's own writer (ADR 12
 *  D9; `records.userReadPosition.edit`, POD-6673). Cursor rows ride entity kind
 *  `userReadPosition`, so bootstrap and delta share one log. */
export type ReadPositionCommandWriter = Pick<LedgerWriter, 'commit'>

export class ReadPositionService {
  constructor(private readonly deps: ReadPositionServiceDeps) {}

  /**
   * Advance one stream's position for one person. Nothing is answered: the
   * person's devices learn the position from the `userReadPosition` row.
   */
  async advance(
    writer: ReadPositionCommandWriter,
    userId: UserId,
    streamId: string,
    proposed: StoredReadPosition,
    now: string,
  ): Promise<void> {
    // One commit: the cursor row, and the change entry the Authority finds by
    // building the record before and after (compare at save, POD-6769). A
    // proposal at or behind the stored position moves nothing and appends
    // nothing.
    await writer.commit({
      write: async (scope) =>
        await this.deps.cursors.advance(scope, userId, streamId, proposed, now),
    })
  }
}
