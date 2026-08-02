/**
 * Layout service (POD-1350) — read and write the calling principal's
 * sidebar/tab layout snapshot.
 *
 * Bootstrap: {@link getSnapshot} is what a reconnecting client hydrates from
 * (POD-403). Writes: {@link set} / {@link clear} are the command handlers behind
 * `layout.set` / `layout.clear`. Both return the full post-write snapshot so the
 * ui-state module has one seam to consume.
 */

import type { LayoutSnapshot, UserId } from '@podium/model'
import type { UserLayoutRepository } from '../../store/user-layout'

export class LayoutService {
  constructor(private readonly layout: UserLayoutRepository) {}

  getSnapshot(userId: UserId): LayoutSnapshot {
    return this.layout.getSnapshot(userId)
  }

  set(userId: UserId, values: Record<string, unknown>, now: string): LayoutSnapshot {
    this.layout.setMany(userId, values, now)
    return this.layout.getSnapshot(userId)
  }

  clear(userId: UserId, keys: readonly string[]): LayoutSnapshot {
    this.layout.clearMany(userId, keys)
    return this.layout.getSnapshot(userId)
  }
}
