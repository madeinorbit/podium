/**
 * THE OUTBOX'S STORAGE (POD-6681): three JSON blobs over the device's
 * `StorageApi`, one per stage of the queue (queued, awaiting truth, parked),
 * plus the one-time fold of a queue an older build left under the legacy keys.
 *
 * Moved verbatim out of the kernel replica's side cache, which keeps only the
 * device's UI state. The keys, the fold and the loud write failure are
 * unchanged; the side cache still hands these stores to the replica facade, so
 * the outbox reaches them through `replica.outboxStorage()` as before.
 */

import { createLogger } from '@podium/logger'
import { OUTBOX_LS_KEY, type OutboxEntry, type OutboxStorage } from '../../outbox'
import type { StorageApi } from '../../replica/contract'

const log = createLogger('client-core:side-cache')

export interface OutboxStorageInit {
  storage: StorageApi
  /** The principal's namespace; the same prefix the side cache uses. */
  keyPrefix?: string
  /** Overridable for tests; defaults to the two homes the legacy path uses. */
  legacyOutboxKeys?: readonly string[]
  /** Surfaced, never swallowed (ADR 6 D4.4 clause 3): a queued write that could not be persisted. */
  onDegraded?: (error: unknown) => void
  /** May the legacy queue found on this device be adopted as this user's work? See `SideCacheInit`. */
  adoptLegacyOutbox?: boolean
}

/** The outbox's three homes. */
export interface OutboxStorageHomes {
  outboxStorage(): OutboxStorage
  outboxAwaitingStorage(): OutboxStorage
  outboxDeadLetterStorage(): OutboxStorage
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

export function createOutboxStorage(init: OutboxStorageInit): OutboxStorageHomes {
  const prefix = init.keyPrefix ?? 'podium.kernel-replica'
  const outboxKey = `${prefix}.outbox.v1`
  const awaitingKey = `${prefix}.outbox-awaiting.v1`
  // POD-316: parked entries. A THIRD key old builds never read, for the same
  // reason the awaiting home is separate — a build that predates the state would
  // re-drain a definitively-refused mutation as live work.
  const deadLetterKey = `${prefix}.outbox-dead-letter.v1`
  const { storage } = init

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
    outboxStorage: () => outboxAt(outboxKey),
    outboxAwaitingStorage: () => outboxAt(awaitingKey),
    outboxDeadLetterStorage: () => outboxAt(deadLetterKey),
  }
}
