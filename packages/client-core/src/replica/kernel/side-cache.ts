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

import { createLogger } from '@podium/logger'
import { OUTBOX_LS_KEY, type OutboxEntry, type OutboxStorage } from '../../outbox'
import {
  LEGACY_UI_KEYS,
  LEGACY_UI_MAP_PREFIXES,
  LEGACY_UI_PREFIXES,
  MIRRORED_UI_KEYS,
  type StorageApi,
  type StorageEventApi,
  type UiState,
} from '../contract'

const log = createLogger('client-core:side-cache')

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

/**
 * Where a queued write can be sitting when the flag flips.
 *
 * Two homes, because the legacy path itself has two: the PRE-collection JSON
 * array at `podium.outbox.v1` (`OUTBOX_LS_KEY`, which the legacy replica folds
 * in on its own first use), and the collection blob at
 * `podium.replica.outbox.v1` once it has. A migration that read only one of them
 * would lose whichever the user happened to have.
 */
const DEFAULT_LEGACY_OUTBOX_KEYS = [OUTBOX_LS_KEY, 'podium.replica.outbox.v1'] as const

/**
 * Read a legacy outbox blob WITHOUT knowing which of the two shapes it is in.
 *
 * The pre-collection blob is a JSON ARRAY of entries. The collection blob is
 * TanStack's own on-disk format — an object whose values are the rows — and its
 * exact envelope is the library's private business, not a contract this module
 * may depend on. So the read is structural rather than format-aware: walk one
 * level of whatever is there and keep the values that LOOK like an entry
 * (`mutationId` + `kind` + `queuedAt`). A shape it cannot recognise yields
 * nothing, which is the same outcome as today's silent loss and never worse.
 *
 * This is duck-typing a foreign format on purpose, and the reason it is
 * acceptable here is the failure direction: a false negative loses nothing that
 * was not already lost, and a false positive replays a mutation the server
 * dedupes by `mutationId`.
 */
function readLegacyOutbox(storage: StorageApi, key: string): OutboxEntry[] {
  let parsed: unknown
  try {
    const raw = storage.getItem(key)
    if (raw === null) return []
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const candidates: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>)
      : []
  const entries: OutboxEntry[] = []
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    const row = candidate as Partial<OutboxEntry>
    if (typeof row.mutationId !== 'string') continue
    if (typeof row.kind !== 'string') continue
    if (typeof row.queuedAt !== 'number') continue
    entries.push(row as OutboxEntry)
  }
  return entries
}

/** Best-effort — UI-STATE AND TRANSCRIPTS ONLY. A quota failure there degrades
 *  persistence and does not break the UI: a lost sidebar width is not a
 *  correctness bug, and a preference write that took the app down would be a
 *  worse defect than the one it guarded against. The outbox is NOT this; see
 *  `writeQueued`. */
function writeJson(storage: StorageApi, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // best-effort, exactly like the legacy path's degraded mode
  }
}

/**
 * THE OUTBOX IS NOT BEST-EFFORT.
 *
 * ADR 6 D4.3 puts queued entries on the same footing as entity rows: losing them
 * on a crash is a correctness bug, not degraded UX. The legacy path routed the
 * outbox family through a separate loud wrapper for exactly this reason, and
 * dropping that on the way to the kernel path is a regression rather than a
 * simplification — an empty catch here means a user's offline rename is gone and
 * the app said nothing.
 *
 * Log, surface (D4.4 clause 3), and RETHROW. The rethrow is the load-bearing
 * part: a caller must not be allowed to believe a queued write is safe when it
 * is not. The asymmetry is the whole argument — a lost queued write is not
 * recoverable, while a replayed one is a no-op, because every entry carries a
 * stable `mutationId` the server dedupes on.
 */
function writeQueued(
  storage: StorageApi,
  key: string,
  entries: readonly OutboxEntry[],
  onDegraded: (error: unknown) => void,
): void {
  try {
    storage.setItem(key, JSON.stringify(entries))
  } catch (error) {
    const failure = new OutboxNotDurableError(key, entries, storage, error)
    log.error(failure.message, { key, err: error })
    onDegraded(failure)
    throw failure
  }
}

/**
 * A DENIED OUTBOX WRITE, SAID DETERMINATELY.
 *
 * The legacy path's observable — "queued offline writes MAY be LOST on reload"
 * (POD-785 watched it fire in a real client) — is the defect wearing the costume
 * of its own fix. It reports that something might have happened, names no
 * mutation, and cannot be told apart from a run in which nothing was lost. A
 * signal a reader cannot act on leaves the queue exactly as unaccountable as the
 * empty catch did; it just makes the log longer.
 *
 * So this reads the store back and DIFFS it. A blob rewrite that throws leaves
 * the previous value in place (measured, not assumed — see the suite's
 * bounded-loss case), which means the durable set is knowable at the moment of
 * failure and the shortfall is exactly the entries missing from it. `notDurable`
 * is that shortfall by mutationId: what is in memory, is not on disk, and will
 * not survive a reload.
 *
 * The read-back is itself guarded. A store that denies a write may well refuse a
 * read, and a diagnostic that throws while explaining a throw would replace a
 * determinate answer with none — so an unreadable store degrades to "every entry
 * is unaccounted for", which is the honest reading of it.
 */
export class OutboxNotDurableError extends Error {
  readonly kind = 'outbox-not-durable' as const
  /** Which home refused: the queued, awaiting-truth or dead-letter blob. */
  readonly stage: string
  /** In memory, NOT on disk. These are the writes a reload would lose. */
  readonly notDurable: readonly string[]
  /** Confirmed on disk after the failure — the queue that a reload still sees. */
  readonly durable: readonly string[]

  constructor(
    stage: string,
    attempted: readonly OutboxEntry[],
    storage: StorageApi,
    override readonly cause: unknown,
  ) {
    const durable = readDurableIds(storage, stage)
    const notDurable = attempted.map((e) => e.mutationId).filter((id) => !durable.has(id))
    super(
      `[podium] OUTBOX write NOT durable (${stage}): ${notDurable.length} of ${attempted.length} ` +
        `queued writes are not on disk and will be lost on reload — ` +
        `${notDurable.length === 0 ? 'none' : notDurable.join(', ')}`,
    )
    this.name = 'OutboxNotDurableError'
    this.stage = stage
    this.durable = [...durable]
    this.notDurable = notDurable
  }
}

/** What the store will still hand back after a refused write. An unreadable or
 *  unparseable store yields NOTHING durable rather than a guess. */
function readDurableIds(storage: StorageApi, key: string): Set<string> {
  const ids = new Set<string>()
  try {
    const raw = storage.getItem(key)
    if (raw === null) return ids
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return ids
    for (const row of parsed) {
      const id = (row as { mutationId?: unknown } | null)?.mutationId
      if (typeof id === 'string') ids.add(id)
    }
  } catch {
    return new Set<string>()
  }
  return ids
}

export function createSideCache(init: SideCacheInit): SideCache {
  const prefix = init.keyPrefix ?? 'podium.kernel-replica'
  const outboxKey = `${prefix}.outbox.v1`
  const awaitingKey = `${prefix}.outbox-awaiting.v1`
  // POD-316: parked entries. A THIRD key old builds never read, for the same
  // reason the awaiting home is separate — a build that predates the state would
  // re-drain a definitively-refused mutation as live work.
  const deadLetterKey = `${prefix}.outbox-dead-letter.v1`
  const { storage } = init

  // ---- outbox storage ----------------------------------------------------
  //
  // FOLD THE LEGACY QUEUE IN ON FIRST USE, because the alternative is losing
  // user-authored work at the moment somebody flips a flag.
  //
  // Turning `kernel-replica` on moves the engine's outbox from the legacy
  // replica's collection to this module's key. Anything queued OFFLINE under
  // the old path — a rename, an archive, a snooze the user made on a train —
  // would otherwise sit in a blob nothing reads again, and the user would never
  // be told. ADR 6 D4.3 puts queued entries in the same durability class as
  // entity rows, and POD-377's brief is explicit that queued work is never
  // silently discarded. A cache can be re-derived; this cannot.
  //
  // Raw blobs retire after the acting principal's copy and marker are durable;
  // leaving them for rollback would let a second principal consume the queue.
  migrateLegacyOutbox()

  function migrateLegacyOutbox(): void {
    // Attribution first: an unattributable queue is LEFT WHERE IT IS, not
    // adopted and not destroyed, and the fold stays un-marked so a later
    // attributable boot can still take it.
    if (init.adoptLegacyOutbox === false) return
    if (storage.getItem(`${outboxKey}.migrated`) !== null) return
    const found: OutboxEntry[] = []
    for (const key of init.legacyOutboxKeys ?? DEFAULT_LEGACY_OUTBOX_KEYS) {
      for (const entry of readLegacyOutbox(storage, key)) {
        if (!found.some((e) => e.mutationId === entry.mutationId)) found.push(entry)
      }
    }
    if (found.length > 0) {
      const existing = readJson<OutboxEntry[]>(storage, outboxKey, [])
      const merged = [...existing]
      for (const entry of found) {
        if (!merged.some((e) => e.mutationId === entry.mutationId)) merged.push(entry)
      }
      writeQueued(storage, outboxKey, merged, (error) => init.onDegraded?.(error))
    }
    try {
      storage.setItem(`${outboxKey}.migrated`, '1')
      for (const key of init.legacyOutboxKeys ?? DEFAULT_LEGACY_OUTBOX_KEYS) {
        storage.removeItem(key)
      }
    } catch {
      // The namespaced copy is durable. A failed marker/removal causes an
      // idempotent retry by mutationId; it never drops queued work.
    }
  }

  const outboxAt = (key: string): OutboxStorage => ({
    load: () => readJson<OutboxEntry[]>(storage, key, []) as OutboxEntry[],
    save: (entries: OutboxEntry[]) =>
      writeQueued(storage, key, entries, (error) => init.onDegraded?.(error)),
  })

  return {
    deviceStorage: () => ({
      storage,
      keyPrefix: prefix,
      flush: init.flush,
    }),
    outboxStorage: () => outboxAt(outboxKey),
    outboxAwaitingStorage: () => outboxAt(awaitingKey),
    outboxDeadLetterStorage: () => outboxAt(deadLetterKey),
    dispose: () => {},
  }
}
