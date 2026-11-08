/**
 * THE PER-USER RECORDS' BOOT TRUTH (POD-6673): the back-fill.
 *
 * Pins, tab orders and preferences were stored long before they were synced, so
 * their rows are not on the change log. At boot, before the first bootstrap,
 * each kind's full truth is reconciled onto the log: every stored row becomes an
 * upsert, and a logged row whose storage is gone becomes a remove. The Authority
 * skips rows that did not change, so a restart appends nothing new.
 *
 * Rolling the change back needs no data step: the storage tables are unchanged
 * in shape, and an older build ignores these kinds' log rows (it parses them as
 * unknown kinds and advances its cursor).
 */

import { pinRowId, tabOrderRowId, type UserId, userPreferencesRowId } from '@podium/model'
import type { LedgerWriter } from '@podium/sync'
import type { SessionStore } from '../../store'

/** What the reconcile appends through: the boot's `server` writer. */
export interface UserRecordsReconcileWriter {
  reconcile(
    entity: Parameters<LedgerWriter['reconcile']>[0],
    rows: { id: string; value: unknown }[],
  ): Promise<unknown>
}

export async function reconcileUserRecords(
  writer: UserRecordsReconcileWriter,
  store: Pick<SessionStore, 'sessions' | 'settings'>,
): Promise<void> {
  const pins = await store.sessions.allPinsForBootReconcile()
  await writer.reconcile(
    'pin',
    pins.map((value) => ({
      id: pinRowId(value.userId as UserId, value.kind, value.entityId),
      value,
    })),
  )
  const orders = await store.sessions.allTabOrdersForBootReconcile()
  await writer.reconcile(
    'tabOrder',
    orders.map((value) => ({ id: tabOrderRowId(value.userId as UserId, value.entityId), value })),
  )
  const preferences = await store.settings.allPreferenceRecordsForBootReconcile()
  await writer.reconcile(
    'userPreferences',
    preferences.map((value) => ({ id: userPreferencesRowId(value.userId), value })),
  )
}
