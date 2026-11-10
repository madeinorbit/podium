/**
 * THE CHANGE ENTRIES OF THE PER-USER RECORDS (POD-6673, ADR 12 D1).
 *
 * `pin`, `tabOrder` and `userPreferences` rows are published on the change log
 * by the write that changes them, inside its commit, so a second device of the
 * same person hears of a pin, an order or a preference without asking. The feed
 * delivers them to their owner only (`feed-visibility.ts`, `per-user-state`).
 *
 * A pin and a tab order compare at save (POD-6769): the write names the record
 * and the Authority builds it before and after. A preferences record is still
 * declared whole.
 */

import {
  type PinKind,
  pinRowId,
  tabOrderRowId,
  type UserId,
  type UserPreferencesWire,
  userPreferencesRowId,
} from '@podium/model'
import type { AffectedRecordSpec, EntityChangeSpec } from '@podium/sync'

/** One person's pin of one thing: the record a pin or an unpin may affect. */
export function pinRecord(userId: UserId, kind: PinKind, entityId: string): AffectedRecordSpec {
  return { entity: 'pin', id: pinRowId(userId, kind, entityId) }
}

/** One person's tab order of one worktree, as stored (an empty order is no
 *  record): the record a reorder may affect. */
export function tabOrderRecord(userId: UserId, worktree: string): AffectedRecordSpec {
  return { entity: 'tabOrder', id: tabOrderRowId(userId, worktree.trim()) }
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
