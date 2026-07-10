import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'

/**
 * Shared internals of the durable metadata change log [spec:SP-3fe2] (#253):
 * the dedup baseline, the conversation significance projection, the retention
 * policy, and the cursor read path. Consumed by both writers — the legacy
 * broadcast-seam {@link MetadataOplog} and the write-seam {@link Ledger} —
 * which must agree byte-for-byte on what counts as "a change" while they
 * coexist during the seam migration. Internal module: not exported from the
 * package index.
 */

/** Narrow structural view over SyncRepository — everything a change-log
 *  writer needs. Injected so the writers never depend on the outbox half of
 *  the repository (and so tests can wrap/stub the append). */
export interface ChangeLogStore {
  /** Append pre-diffed rows atomically; returns their contiguous seqs. */
  appendChanges(
    rows: { entity: string; entityId: string; op: 'upsert' | 'remove'; payload: string | null }[],
    eventTime: number,
  ): number[]
  /** Highest seq ever assigned (survives head-pruning). 0 = none. */
  maxChangeSeq(): number
  /** Lowest RETAINED seq, or null when the log is empty. */
  minChangeSeq(): number | null
  /** Plain range read: rows with seq > cursor, in seq order. */
  changesSince(
    cursor: number,
  ): { seq: number; entity: string; entityId: string; op: string; payload: string | null }[]
  /** Head-only retention (row budget OR age budget, whichever deletes more). */
  pruneChanges(opts: { keepRows: number; maxAgeMs: number; now: number }): void
  /** Latest retained row per (entity, id) — the boot seed for the baseline. */
  latestChangeStates(): { entity: string; entityId: string; op: string; payload: string | null }[]
}

/** Retention: keep the newest 20k rows, and nothing older than 3 days —
 *  whichever budget deletes more (store.pruneChanges, head-only). */
export const CHANGE_KEEP_ROWS = 20_000
export const CHANGE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
/** Prune cadence, counted in APPEND BATCHES that actually wrote rows. */
export const CHANGE_PRUNE_EVERY = 64

/** Conversation fields that churn on every discovery scan (activity bumps) —
 *  EXCLUDED from change detection so a scan storm doesn't re-record the full
 *  payload per conversation per scan (the 81MB/day churn fix). The durable
 *  payload stays the full wire value — only change DETECTION is projected.
 *  Staleness tradeoff: delta clients see these fields refresh only when a
 *  stable field also changes, or on their next reconnect snapshot —
 *  acceptable for advisory recency/count hints. */
export function conversationProjection(value: unknown): string {
  const {
    updatedAt: _updatedAt,
    messageCount: _messageCount,
    statusHint: _statusHint,
    ...stable
  } = value as Record<string, unknown>
  return JSON.stringify(stable)
}

/**
 * The in-memory dedup baseline: per (entity, id), the serialized wire JSON of
 * the last recorded state — plus, for conversations, the stable-field
 * projection that is the actual change-detection key for that entity.
 *
 * Owned by exactly one writer at a time; callers mutate it only AFTER the
 * durable append committed, so a throw mid-append never desyncs it from the
 * log.
 */
export class ChangeBaseline {
  /** entity -> id -> serialized wire JSON of the last recorded state. */
  private readonly last = new Map<MetadataEntityKind, Map<string, string>>()
  /** Conversation id -> stable-field projection JSON of the last recorded state. */
  private readonly convProjection = new Map<string, string>()

  private byEntity(entity: MetadataEntityKind): Map<string, string> {
    let m = this.last.get(entity)
    if (!m) {
      m = new Map()
      this.last.set(entity, m)
    }
    return m
  }

  /** Boot fold: seed from the latest retained upsert per (entity, id), so the
   *  first record after a restart emits deltas for anything that changed while
   *  the server was down. A corrupt conversation payload seeds no projection —
   *  the first sighting then re-upserts it. */
  seed(store: Pick<ChangeLogStore, 'latestChangeStates'>): void {
    for (const row of store.latestChangeStates()) {
      if (row.op !== 'upsert' || row.payload == null) continue
      this.byEntity(row.entity as MetadataEntityKind).set(row.entityId, row.payload)
      if (row.entity === 'conversation') {
        try {
          this.convProjection.set(row.entityId, conversationProjection(JSON.parse(row.payload)))
        } catch {} // corrupt payload -> no baseline; first record re-upserts it
      }
    }
  }

  /** Would upserting (id, value) change anything? Byte-equality on the
   *  serialized JSON, except conversations, which compare on the stable-field
   *  projection (see {@link conversationProjection}). */
  upsertChanged(entity: MetadataEntityKind, id: string, value: unknown, json: string): boolean {
    if (entity === 'conversation') {
      return this.convProjection.get(id) !== conversationProjection(value)
    }
    return this.byEntity(entity).get(id) !== json
  }

  has(entity: MetadataEntityKind, id: string): boolean {
    return this.byEntity(entity).has(id)
  }

  /** Ids currently present in the baseline for one entity kind (remove-diff input). */
  ids(entity: MetadataEntityKind): string[] {
    return [...this.byEntity(entity).keys()]
  }

  applyUpsert(entity: MetadataEntityKind, id: string, value: unknown, json: string): void {
    this.byEntity(entity).set(id, json)
    if (entity === 'conversation') this.convProjection.set(id, conversationProjection(value))
  }

  applyRemove(entity: MetadataEntityKind, id: string): void {
    this.byEntity(entity).delete(id)
    if (entity === 'conversation') this.convProjection.delete(id)
  }
}

/**
 * Catch-up read for `sync.changesSince`. Returns null when the caller must fall
 * back to a snapshot: null cursor (bootstrap), a cursor from before the retained
 * range (compaction), a cursor from the future (server DB was reset), or a
 * corrupt upsert row in the range (snapshot instead of a hole).
 */
export function readChangesSince(
  store: Pick<ChangeLogStore, 'maxChangeSeq' | 'minChangeSeq' | 'changesSince'>,
  cursor: number | null,
): MetadataChange[] | null {
  const max = store.maxChangeSeq()
  if (cursor == null || cursor > max) return null
  if (cursor === max) return []
  const min = store.minChangeSeq()
  // Continuity: everything in (cursor, max] must still be retained. The oldest
  // retained row must be no newer than cursor + 1, else rows were pruned away.
  if (min == null || min > cursor + 1) return null
  const changes: MetadataChange[] = []
  // Page until exhausted: the repository read is LIMITed (10k default), and a
  // single truncated read would hand the caller rows 1..10000 while cursor()
  // reports the true head — consumers would advance past the missing tail and
  // permanently skip it. Synchronous single-writer process, so paging to `max`
  // terminates.
  let from = cursor
  while (from < max) {
    const rows = store.changesSince(from)
    if (rows.length === 0) break
    for (const r of rows) {
      const base = { seq: r.seq, id: r.entityId, op: r.op as 'upsert' | 'remove' }
      if (r.op === 'upsert') {
        if (r.payload == null) return null // corrupt row — snapshot instead of a hole
        let value: unknown
        try {
          value = JSON.parse(r.payload)
        } catch {
          return null // malformed payload — same corrupt-row contract as null
        }
        changes.push({
          ...base,
          entity: r.entity as MetadataEntityKind,
          value,
        } as MetadataChange)
      } else {
        changes.push({ ...base, entity: r.entity as MetadataEntityKind } as MetadataChange)
      }
    }
    from = rows[rows.length - 1]?.seq ?? max
  }
  return changes
}
