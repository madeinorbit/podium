/**
 * THE CHANGE ENTRIES OF THE PER-USER RECORDS (POD-6673, ADR 12 D1).
 *
 * `pin`, `tabOrder` and `userPreferences` rows are published on the change log
 * by the write that changes them, inside its commit, so a second device of the
 * same person hears of a pin, an order or a preference without asking. The feed
 * delivers them to their owner only (`feed-visibility.ts`, `per-user-state`).
 *
 * All three compare at save (POD-6769): the write names the record and the
 * Authority builds it before and after. A preferences write names its record
 * in the settings service.
 */

import {
  type PinKind,
  pinRowId,
  tabOrderRowId,
  type UserId,
} from '@podium/model'
import type { AffectedRecordSpec } from '@podium/sync'

/** One person's pin of one thing: the record a pin or an unpin may affect. */
export function pinRecord(userId: UserId, kind: PinKind, entityId: string): AffectedRecordSpec {
  return { entity: 'pin', id: pinRowId(userId, kind, entityId) }
}

/** One person's tab order of one worktree, as stored (an empty order is no
 *  record): the record a reorder may affect. */
export function tabOrderRecord(userId: UserId, worktree: string): AffectedRecordSpec {
  return { entity: 'tabOrder', id: tabOrderRowId(userId, worktree.trim()) }
}
