/** Persistent outbox homes plus the raw device-storage port used by UiStore.
 * No screen state or record data is held here. UI values are owned by UiStore
 * and its persistence; transcript history has its own database. */

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
