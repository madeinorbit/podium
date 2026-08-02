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

import {
  type ReadPositionSnapshot,
  type ReadPositionWire,
  readPositionRowId,
  type UserId,
} from '@podium/model'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import type { StoredReadPosition, UserReadPositionRepository } from '../../store/user-read-position'

export interface ReadPositionServiceDeps {
  readonly cursors: UserReadPositionRepository
  /**
   * Write-seam ledger. Cursor rows ride entity kind `userReadPosition` so bootstrap
   * and delta share one log. Optional only for pure unit tests of storage;
   * production always wires it.
   */
  readonly ledger?: Pick<Ledger, 'capture'>
}

export class ReadPositionService {
  constructor(private readonly deps: ReadPositionServiceDeps) {}

  getSnapshot(userId: UserId): ReadPositionSnapshot {
    return this.deps.cursors.getSnapshot(userId)
  }

  /**
   * Advance one stream's position for one person and return their whole
   * snapshot — the same response shape `layout.set` uses, so the client
   * reconciles from one authoritative object rather than patching a delta it
   * would have to merge itself.
   */
  advance(
    userId: UserId,
    streamId: string,
    proposed: StoredReadPosition,
    now: string,
  ): ReadPositionSnapshot {
    const moved = this.deps.cursors.advance(userId, streamId, proposed, now)
    if (moved !== null) {
      this.publish(userId, streamId, moved)
    }
    return this.deps.cursors.getSnapshot(userId)
  }

  private publish(userId: UserId, streamId: string, cursor: StoredReadPosition): void {
    const ledger = this.deps.ledger
    if (!ledger) return
    const value: ReadPositionWire = {
      userId,
      streamId,
      lastEventId: cursor.lastEventId,
      seenAt: cursor.seenAt,
    }
    const spec: EntityChangeSpec = {
      entity: 'userReadPosition',
      id: readPositionRowId(userId, streamId),
      op: 'upsert',
      value,
    }
    ledger.capture([spec])
  }
}
