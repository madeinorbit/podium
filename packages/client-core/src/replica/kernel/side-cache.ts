/**
 * THE CLIENT-SIDE BULK CACHE, which is deliberately NOT replica data.
 *
 * Three things the engine reads through the `Replica` interface have no home in
 * the kernel Replica and must not acquire one:
 *
 *   - **transcript windows** — the brief says so in as many words ("the
 *     transcript-window LRU stays a client-side bulk-plane cache and is out of
 *     replica scope"). They are a bounded cache of a bulk read, re-fetchable at
 *     will, and putting them in the entity cache would put ~200 items × 50
 *     conversations through the feed's transactional path for no gain.
 *   - **ui-state** — a local preference. It has no authority row, it is never
 *     synced, and a `discardCache()` (an epoch bump, a rescope) must not throw
 *     away which sidebar tab you had open.
 *   - **the outbox queue** — see `facade.ts`; on this branch it stays on the
 *     client Outbox's own storage seam rather than being re-minted as kernel
 *     command envelopes.
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

import type { TranscriptItem } from '@podium/model'
import type { OutboxEntry, OutboxStorage } from '../../outbox'
import {
  LEGACY_UI_KEYS,
  LEGACY_UI_MAP_PREFIXES,
  LEGACY_UI_PREFIXES,
  MIRRORED_UI_KEYS,
  REPLICA_TRANSCRIPT_CONVERSATION_CAP,
  REPLICA_TRANSCRIPT_ITEM_CAP,
  type StorageApi,
  type StorageEventApi,
  type TranscriptWindow,
  type UiState,
} from '../replica'

export interface SideCacheInit {
  storage: StorageApi
  storageEventApi?: StorageEventApi
  enumerateKeys?: () => string[]
  keyPrefix?: string
  now?: () => number
}

/** The read/write surface `facade.ts` delegates its non-entity duties to. */
export interface SideCache {
  uiState(): UiState
  transcriptWindow(conversationKey: string): TranscriptWindow | undefined
  putTranscriptWindow(conversationKey: string, items: TranscriptItem[]): void
  outboxStorage(): OutboxStorage
  outboxAwaitingStorage(): OutboxStorage
}

/** Never throws: a poisoned or foreign blob reads as empty, like the legacy
 *  replica's loader (spec invariant 2). */
function readJson<T>(storage: StorageApi, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    return parsed === null || typeof parsed !== 'object' ? fallback : (parsed as T)
  } catch {
    return fallback
  }
}

/** Best-effort: a quota failure degrades persistence, it does not break the UI. */
function writeJson(storage: StorageApi, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // best-effort, exactly like the legacy path's degraded mode
  }
}

export function createSideCache(init: SideCacheInit): SideCache {
  const prefix = init.keyPrefix ?? 'podium.kernel-replica'
  const now = init.now ?? (() => Date.now())
  const uiKey = `${prefix}.uistate.v1`
  const transcriptKey = `${prefix}.transcripts.v1`
  const outboxKey = `${prefix}.outbox.v1`
  const awaitingKey = `${prefix}.outbox-awaiting.v1`
  const { storage } = init

  // ---- ui-state ----------------------------------------------------------
  let ui = readJson<Record<string, string>>(storage, uiKey, {})
  const uiListeners = new Set<() => void>()
  migrateLegacyUiKeys()

  function migrateLegacyUiKeys(): void {
    if (storage.getItem(`${uiKey}.migrated`) !== null) return
    const enumerate =
      init.enumerateKeys ??
      (() => {
        try {
          return Object.keys(storage as unknown as Record<string, unknown>)
        } catch {
          return []
        }
      })
    const mirrored = new Set<string>(MIRRORED_UI_KEYS)
    const take = (key: string, target = key): void => {
      const value = storage.getItem(key)
      if (value === null) return
      ui[target] = value
      if (!mirrored.has(key)) {
        try {
          storage.removeItem(key)
        } catch {
          // leaving the old key behind is harmless; the new one wins
        }
      }
    }
    for (const key of LEGACY_UI_KEYS) take(key)
    for (const key of MIRRORED_UI_KEYS) take(key)
    let enumerated: string[] = []
    try {
      enumerated = enumerate()
    } catch {
      enumerated = []
    }
    for (const key of enumerated) {
      if (LEGACY_UI_PREFIXES.some((p) => key.startsWith(p))) take(key)
      for (const [prefixKey, target] of Object.entries(LEGACY_UI_MAP_PREFIXES)) {
        if (!key.startsWith(prefixKey)) continue
        const value = storage.getItem(key)
        if (value === null) continue
        const map = JSON.parse(ui[target] ?? '{}') as Record<string, string>
        map[key.slice(prefixKey.length)] = value
        ui[target] = JSON.stringify(map)
        try {
          storage.removeItem(key)
        } catch {
          // best-effort
        }
      }
    }
    writeJson(storage, uiKey, ui)
    try {
      storage.setItem(`${uiKey}.migrated`, '1')
    } catch {
      // a storage that cannot record the migration re-runs it; the fold is idempotent
    }
  }

  // Cross-tab: another tab's write to our key re-reads and notifies, matching
  // the legacy collection's `storage` event behaviour.
  init.storageEventApi?.addEventListener?.('storage', (event) => {
    if (event.key !== uiKey) return
    ui = readJson<Record<string, string>>(storage, uiKey, {})
    for (const cb of uiListeners) cb()
  })

  const uiState: UiState = {
    get: (key) => ui[key] ?? null,
    set: (key, value) => {
      if (value === null) {
        if (!(key in ui)) return
        delete ui[key]
      } else {
        if (ui[key] === value) return
        ui[key] = value
      }
      writeJson(storage, uiKey, ui)
      for (const cb of uiListeners) cb()
    },
    subscribe: (cb) => {
      uiListeners.add(cb)
      return () => uiListeners.delete(cb)
    },
  }

  // ---- transcript windows (bounded, LRU) ---------------------------------
  const transcripts = readJson<Record<string, TranscriptWindow>>(storage, transcriptKey, {})

  // ---- outbox storage ----------------------------------------------------
  const outboxAt = (key: string): OutboxStorage => ({
    load: () => readJson<OutboxEntry[]>(storage, key, []) as OutboxEntry[],
    save: (entries: OutboxEntry[]) => writeJson(storage, key, entries),
  })

  return {
    uiState: () => uiState,
    transcriptWindow: (conversationKey) => transcripts[conversationKey],
    putTranscriptWindow: (conversationKey, items) => {
      transcripts[conversationKey] = {
        items: items.slice(-REPLICA_TRANSCRIPT_ITEM_CAP),
        savedAt: now(),
      }
      // LRU by write time — the same cap and the same eviction order as the
      // legacy path, so a flag flip does not change how much is cached.
      const keys = Object.keys(transcripts)
      if (keys.length > REPLICA_TRANSCRIPT_CONVERSATION_CAP) {
        const byAge = keys.sort(
          (a, b) => (transcripts[a]?.savedAt ?? 0) - (transcripts[b]?.savedAt ?? 0),
        )
        for (const stale of byAge.slice(0, keys.length - REPLICA_TRANSCRIPT_CONVERSATION_CAP)) {
          delete transcripts[stale]
        }
      }
      writeJson(storage, transcriptKey, transcripts)
    },
    outboxStorage: () => outboxAt(outboxKey),
    outboxAwaitingStorage: () => outboxAt(awaitingKey),
  }
}
