import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import { runTimeBudgetedJob, type TimeBudgetedJobMetrics } from '@podium/runtime/time-budget'

/**
 * Internals of the durable metadata change log [spec:SP-3fe2] (#253): the
 * dedup baseline, the conversation significance projection, the retention
 * policy, and the cursor read path. Consumed by the write-seam {@link Ledger}
 * — the log's single writer since P2f deleted the legacy broadcast-seam
 * oplog (#258). Internal module: not exported from the package index.
 */
export interface ChangePrunePlan {
  readonly thresholdSeq: number
}

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
  /** Snapshot the head-only retention threshold once per job. */
  planChangePrune(opts: {
    keepRows: number
    maxAgeMs: number
    now: number
  }): ChangePrunePlan
  /** Delete one bounded, indexed head batch from a fixed plan. */
  pruneChangeBatch(plan: ChangePrunePlan, batchSize: number): number
  /** Latest retained row per (entity, id) — the boot seed for the baseline. */
  latestChangeStates(): { entity: string; entityId: string; op: string; payload: string | null }[]
}

/** Retention: keep the newest 20k rows, and nothing older than 3 days —
 *  whichever budget deletes more (fixed-plan, head-only batches). */
export const CHANGE_KEEP_ROWS = 20_000
export const CHANGE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
/** Prune cadence, counted in APPEND BATCHES that actually wrote rows. */
export const CHANGE_PRUNE_EVERY = 64
/** Delete-unit bound, measured below the 12ms slice target on representative rows. */
export const CHANGE_PRUNE_BATCH_ROWS = 100

export interface ChangeLogPruneResult {
  deleted: number
  metrics: TimeBudgetedJobMetrics
}

/**
 * Drain eligible change-log rows in bounded delete units under the shared
 * monotonic/macrotask budget [spec:SP-c29e]. This function deliberately does
 * not serialize concurrent jobs; the owner decides whether that is needed.
 */
export async function pruneChangeLog(
  store: Pick<ChangeLogStore, 'planChangePrune' | 'pruneChangeBatch'>,
  opts: {
    keepRows: number
    maxAgeMs: number
    now: number
    signal?: AbortSignal
    /** Monotonic clock seam for deterministic slice tests. */
    monotonicNow?: () => number
    onMetrics?: (metrics: TimeBudgetedJobMetrics) => void
  },
): Promise<ChangeLogPruneResult> {
  let deleted = 0
  let plan: ChangePrunePlan | undefined
  const metrics = await runTimeBudgetedJob(
    () => {
      if (!plan) {
        plan = store.planChangePrune({
          keepRows: opts.keepRows,
          maxAgeMs: opts.maxAgeMs,
          now: opts.now,
        })
        return plan.thresholdSeq > 0 ? 'continue' : 'done'
      }
      const batchDeleted = store.pruneChangeBatch(plan, CHANGE_PRUNE_BATCH_ROWS)
      deleted += batchDeleted
      return batchDeleted < CHANGE_PRUNE_BATCH_ROWS ? 'done' : 'continue'
    },
    {
      signal: opts.signal,
      now: opts.monotonicNow,
      onMetrics: opts.onMetrics,
    },
  )
  return { deleted, metrics }
}

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

/** Issue fields derived from live-session state — EXCLUDED from change
 *  detection (POD-210, same shape as {@link conversationProjection}): the wire
 *  embeds the full member SessionMeta[] plus roll-ups, so every session
 *  heartbeat (working↔idle flip, read receipt, activity stamp) re-serializes
 *  the issue row and was re-recorded to the ledger ~each second per active
 *  session. Live clients keep getting these via the snapshot fan-out, and
 *  sessions are ledgered as their own entity; only the durable issue-change
 *  KEY ignores them. Staleness tradeoff: a delta client's embedded session
 *  snapshot inside an issue row refreshes when a stable field changes or on
 *  its next reconnect snapshot — acceptable for advisory live-state hints. */
export function issueProjection(value: unknown): string {
  const {
    sessions: _sessions,
    sessionSummary: _sessionSummary,
    unread: _unread,
    ...stable
  } = value as Record<string, unknown>
  return JSON.stringify(stable)
}

/** The change-DETECTION key for one entity value: the stable-field projection
 *  for entities with churn-prone derived fields, else the full serialized wire
 *  JSON (`json` must be `JSON.stringify(value)`). */
export function detectionKey(entity: MetadataEntityKind, value: unknown, json: string): string {
  if (entity === 'conversation') return conversationProjection(value)
  if (entity === 'issue') return issueProjection(value)
  return json
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
  /** entity -> id -> DETECTION KEY of the last recorded state (see
   *  {@link detectionKey}: the stable-field projection for projected entities,
   *  else the serialized wire JSON). */
  private readonly last = new Map<MetadataEntityKind, Map<string, string>>()

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
   *  the server was down. A corrupt payload seeds no baseline for its id —
   *  the first sighting then re-upserts it. */
  seed(store: Pick<ChangeLogStore, 'latestChangeStates'>): void {
    for (const row of store.latestChangeStates()) {
      if (row.op !== 'upsert' || row.payload == null) continue
      try {
        const entity = row.entity as MetadataEntityKind
        this.byEntity(entity).set(
          row.entityId,
          detectionKey(entity, JSON.parse(row.payload), row.payload),
        )
      } catch {} // corrupt payload -> no baseline; first record re-upserts it
    }
  }

  /** Would upserting (id, value) change anything? Byte-equality on the
   *  entity's detection key (see {@link detectionKey}). */
  upsertChanged(entity: MetadataEntityKind, id: string, value: unknown, json: string): boolean {
    return this.byEntity(entity).get(id) !== detectionKey(entity, value, json)
  }

  has(entity: MetadataEntityKind, id: string): boolean {
    return this.byEntity(entity).has(id)
  }

  /** Ids currently present in the baseline for one entity kind (remove-diff input). */
  ids(entity: MetadataEntityKind): string[] {
    return [...this.byEntity(entity).keys()]
  }

  applyUpsert(entity: MetadataEntityKind, id: string, value: unknown, json: string): void {
    this.byEntity(entity).set(id, detectionKey(entity, value, json))
  }

  applyRemove(entity: MetadataEntityKind, id: string): void {
    this.byEntity(entity).delete(id)
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
