/**
 * THE CHANGE ENTRIES OF THE PER-USER RECORDS (POD-6673, ADR 12 D1).
 *
 * `pin`, `tabOrder` and `userPreferences` rows are published on the change log
 * by the write that changes them, inside its commit, so a second device of the
 * same person hears of a pin, an order or a preference without asking. The feed
 * delivers them to their owner only (`feed-visibility.ts`, `per-user-state`).
 */

import {
  type PinKind,
  type PinWire,
  pinRowId,
  type TabOrderWire,
  tabOrderRowId,
  type UserId,
  type UserPreferencesWire,
  userPreferencesRowId,
} from '@podium/model'
import type { EntityChangeSpec } from '@podium/sync'

export function pinUpsert(pin: PinWire): EntityChangeSpec {
  return {
    entity: 'pin',
    id: pinRowId(pin.userId as UserId, pin.kind, pin.entityId),
    op: 'upsert',
    value: pin,
  }
}

export function pinRemove(userId: UserId, kind: PinKind, entityId: string): EntityChangeSpec {
  return { entity: 'pin', id: pinRowId(userId, kind, entityId), op: 'remove' }
}

/** A tab order as stored: an empty order is no record. */
export function tabOrderChange(
  userId: UserId,
  worktree: string,
  sessionIds: readonly string[],
): EntityChangeSpec {
  const id = tabOrderRowId(userId, worktree)
  if (sessionIds.length === 0) return { entity: 'tabOrder', id, op: 'remove' }
  const value: TabOrderWire = { userId, entityId: worktree, sessionIds: [...sessionIds] }
  return { entity: 'tabOrder', id, op: 'upsert', value }
}

/** One person's preferences record, whole: the log stores whole rows. */
export function userPreferencesChange(record: UserPreferencesWire): EntityChangeSpec {
  return {
    entity: 'userPreferences',
    id: userPreferencesRowId(record.userId),
    op: 'upsert',
    value: record,
  }
}
