/**
 * Layout service (POD-1350) — read/write the calling principal's layout and
 * publish each mutation onto the Authority change log so a second device of the
 * same user receives the row (scoped feed; POD-402 review gap 2).
 */

import {
  layoutRowId,
  type LayoutSnapshot,
  type LayoutWire,
  type UserId,
} from '@podium/model'
import type { EntityChangeSpec, Ledger } from '@podium/sync'
import type { UserLayoutRepository } from '../../store/user-layout'

export interface LayoutServiceDeps {
  readonly layout: UserLayoutRepository
  /**
   * Write-seam ledger. Layout rows ride entity kind `userLayout` so bootstrap
   * and delta share one log. Optional only for pure unit tests of storage;
   * production always wires it.
   */
  readonly ledger?: Pick<Ledger, 'capture'>
}

export class LayoutService {
  constructor(private readonly deps: LayoutServiceDeps) {}

  getSnapshot(userId: UserId): LayoutSnapshot {
    return this.deps.layout.getSnapshot(userId)
  }

  set(userId: UserId, values: Record<string, unknown>, now: string): LayoutSnapshot {
    this.deps.layout.setMany(userId, values, now)
    this.publish(
      Object.entries(values).map(([key, value]) => ({
        userId,
        key,
        value,
        op: 'upsert' as const,
      })),
    )
    return this.deps.layout.getSnapshot(userId)
  }

  clear(userId: UserId, keys: readonly string[]): LayoutSnapshot {
    this.deps.layout.clearMany(userId, keys)
    this.publish(keys.map((key) => ({ userId, key, op: 'remove' as const })))
    return this.deps.layout.getSnapshot(userId)
  }

  /**
   * Boot reconcile: every durable layout row becomes a positive upsert on the
   * log so a reconnecting principal's bootstrap sees them without a second path.
   */
  reconcileAllToLedger(): void {
    // Full-table read is only for boot. Repository has no all(); use the store
    // SQL via a dedicated path when wired — for now capture is driven by writes.
  }

  private publish(
    rows: ReadonlyArray<
      | { userId: UserId; key: string; value: unknown; op: 'upsert' }
      | { userId: UserId; key: string; op: 'remove' }
    >,
  ): void {
    const ledger = this.deps.ledger
    if (!ledger || rows.length === 0) return
    const specs: EntityChangeSpec[] = rows.map((row) => {
      const id = layoutRowId(row.userId, row.key)
      if (row.op === 'remove') {
        return { entity: 'userLayout', id, op: 'remove' }
      }
      const value: LayoutWire = { userId: row.userId, key: row.key, value: row.value }
      return { entity: 'userLayout', id, op: 'upsert', value }
    })
    ledger.capture(specs)
  }
}
