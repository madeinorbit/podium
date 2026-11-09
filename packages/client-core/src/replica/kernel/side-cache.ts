/**
 * THE CLIENT-SIDE SMALL CACHE, which is deliberately NOT replica data.
 *
 * Two things the engine reads through the `Replica` interface have no home in
 * the kernel Replica and must not acquire one (chat history, once here too, has
 * its own database since POD-5801 — see `transcript-store/`):
 *
 *   - **ui-state** — a local preference. It has no authority row, it is never
 *     synced, and a `discardCache()` (an epoch bump, a rescope) must not throw
 *     away which sidebar tab you had open.
 *   - **the outbox queue** — see `facade.ts`; on this branch it stays on the
 *     client Outbox's own storage seam rather than being re-minted as kernel
 *     command envelopes. That storage is the outbox service's
 *     (`runtime-root/outbox/storage.ts`, POD-6681); this cache only opens it
 *     under the same prefix and hands it to the facade.
 *
 * So this module is a small JSON-blob store over the same `StorageApi` seam the
 * legacy replica uses, with the same cross-tab `storage`-event behaviour. It is
 * NOT a second replica: nothing here is ever compared against the Authority, and
 * the shadow comparison does not look at it.
 *
 * WHAT IT DOES NOT CARRY OVER, stated rather than discovered. Flipping the
 * `kernel-replica` flag moves ui-state from the legacy path's TanStack
 * collection blob to this module's own key. Preferences written under the
 * legacy path before the flip are not read back: the raw pre-collection
 * localStorage keys ARE migrated (same list, same one-time fold as the legacy
 * path), but values that only ever existed inside the collection blob are not,
 * because parsing another library's private on-disk shape to recover a sidebar
 * width is a worse trade than losing the sidebar width.
 */

import type { OutboxStorage } from '../../outbox'
import { createOutboxStorage } from '../../runtime-root/outbox/storage'
import type { StorageApi, StorageEventApi } from '../contract'

// The outbox's storage error, re-exported where the kernel replica's callers find it.
export { OutboxNotDurableError } from '../../runtime-root/outbox/storage'

export interface SideCacheInit {
  flush?: () => void | Promise<void>
  storage: StorageApi
  storageEventApi?: StorageEventApi
  enumerateKeys?: () => string[]
  keyPrefix?: string
  /** Overridable for tests; defaults to the two homes the legacy path uses. */
  legacyOutboxKeys?: readonly string[]
  /** Surfaced, never swallowed (ADR 6 D4.4 clause 3). Fires when a QUEUED write
   *  could not be persisted — the one loss this module must not keep quiet. */
  onDegraded?: (error: unknown) => void
  /**
   * May the legacy queue found on this device be ADOPTED as this user's work?
   *
   * Defaults to true, and the composition root sets it false when the store
   * cannot be attributed with certainty (POD-307's fail-closed rule, POD-1239).
   * Folding in a queue that predates per-user identity is exactly how one
   * person's unsent writes get replayed under another person's account on a
   * shared device — the same hazard POD-377's adoption gate exists for, arriving
   * through the outbox instead of through the entity rows.
   *
   * A refusal does NOT mark the fold as done, so a later boot that CAN attribute
   * the store still adopts it. Declining to adopt is not the same as discarding.
   */
  adoptLegacyOutbox?: boolean
}

/** The read/write surface `facade.ts` delegates its non-entity duties to. */
export interface SideCache {
  deviceStorage(): import('../../ui/device-storage').DeviceStorage
  outboxStorage(): OutboxStorage
  outboxAwaitingStorage(): OutboxStorage
  outboxDeadLetterStorage(): OutboxStorage
  /** Detach this principal's listeners before another principal opens. */
  dispose(): void
}

/**
 * The chat-history keys this module wrote before POD-5801 moved chat history to
 * its own database: per-chat windows, their index, and the v1 blob, under every
 * principal's prefix. Deleted on first start WITHOUT importing them — the server
 * has every message, and the space they held goes back to UI state and drafts.
 */
export function isLegacyTranscriptStorageKey(key: string): boolean {
  return (
    key.includes('.transcript-window.v2.') ||
    key.endsWith('.transcripts-index.v2') ||
    key.endsWith('.transcripts.v1')
  )
}

/** Remove every {@link isLegacyTranscriptStorageKey} key. Best-effort, never throws. */
export function eraseLegacyTranscriptKeys(storage: StorageApi, keys: readonly string[]): void {
  for (const key of keys) {
    if (!isLegacyTranscriptStorageKey(key)) continue
    try {
      storage.removeItem(key)
    } catch {
      // A key that cannot be removed now is retried on the next start.
    }
  }
}

export function createSideCache(init: SideCacheInit): SideCache {
  const prefix = init.keyPrefix ?? 'podium.kernel-replica'
  const { storage } = init

  // ---- outbox storage: the outbox service's (POD-6681) --------------------
  const outbox = createOutboxStorage({
    storage,
    keyPrefix: prefix,
    ...(init.legacyOutboxKeys !== undefined ? { legacyOutboxKeys: init.legacyOutboxKeys } : {}),
    ...(init.adoptLegacyOutbox !== undefined ? { adoptLegacyOutbox: init.adoptLegacyOutbox } : {}),
    ...(init.onDegraded !== undefined ? { onDegraded: init.onDegraded } : {}),
  })

  return {
    deviceStorage: () => ({
      storage,
      keyPrefix: prefix,
      enumerateKeys: init.enumerateKeys,
      flush: init.flush,
    }),
    outboxStorage: outbox.outboxStorage,
    outboxAwaitingStorage: outbox.outboxAwaitingStorage,
    outboxDeadLetterStorage: outbox.outboxDeadLetterStorage,
    dispose: () => {},
  }
}
