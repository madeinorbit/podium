import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import { runTimeBudgetedJob, type TimeBudgetedJobMetrics } from '@podium/runtime/time-budget'
import type { ChangeLogReadRow, ChangeLogWriteRow } from './authority/change-lifecycle'

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

/**
 * Narrow structural view over SyncRepository — everything a change-log writer
 * needs. Injected so the writers never depend on the outbox half of the
 * repository (and so tests can wrap/stub the append).
 *
 * Row shapes are COMPOSED from the lifecycle types (POD-1251), not restated:
 * three inline field lists here used to drift from {@link StoredChangeRow}
 * (`op: string` vs the global op union; missing provenance) and from each
 * other. One definition site cannot disagree with itself.
 */
export interface ChangeLogStore {
  /** Append pre-diffed rows atomically; returns their contiguous seqs. */
  appendChanges(rows: readonly ChangeLogWriteRow[], eventTime: number): number[]
  /** Highest seq ever assigned (survives head-pruning). 0 = none. */
  maxChangeSeq(): number
  /** Lowest RETAINED seq, or null when the log is empty. */
  minChangeSeq(): number | null
  /** Plain range read: rows with seq > cursor, in seq order. */
  changesSince(cursor: number): readonly ChangeLogReadRow[]
  /** Snapshot the head-only retention threshold once per job. */
  planChangePrune(opts: { keepRows: number; maxAgeMs: number; now: number }): ChangePrunePlan
  /** Delete one bounded, indexed head batch from a fixed plan. */
  pruneChangeBatch(plan: ChangePrunePlan, batchSize: number): number
  /** THE INSTALLED WORLD — the latest live state per (entity, id): the boot seed
   *  for the baseline, and the bootstrap read (see
   *  `ChangeStorePort.latestChangeStates`). Independent of retention (POD-678):
   *  the row budget bounds what `changesSince` can serve, never what exists. Only
   *  `upsert` rows come back — a removed entity is not in the world. */
  latestChangeStates(): readonly ChangeLogReadRow[]
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
  if (entity === 'issue') {
    const issue = value as Record<string, unknown>
    // The normalized pilot's transitional IssueWire is already session-free.
    // Reuse its serialized bytes instead of allocating a second projection;
    // legacy embedded-session shapes still receive main's heartbeat filter.
    if (
      !Object.hasOwn(issue, 'sessions') &&
      !Object.hasOwn(issue, 'sessionSummary') &&
      !Object.hasOwn(issue, 'unread')
    ) {
      return json
    }
    return issueProjection(value)
  }
  return json
}

/**
 * One folded row, as the baseline records it. Carries the detection key rather
 * than recomputing it, so a staged row and the row eventually folded into the
 * committed maps cannot disagree about what "changed" means.
 */
export type BaselineFold =
  | {
      readonly entity: MetadataEntityKind
      readonly id: string
      readonly op: 'upsert'
      readonly value: unknown
      readonly key: string
    }
  | { readonly entity: MetadataEntityKind; readonly id: string; readonly op: 'remove' }

/** One staged batch, awaiting the outermost commit that makes it durable. */
interface PendingBatch {
  readonly token: number
  readonly rows: readonly BaselineFold[]
}

/**
 * The in-memory dedup baseline: per (entity, id), the serialized wire JSON of
 * the last recorded state — plus, for conversations, the stable-field
 * projection that is the actual change-detection key for that entity.
 *
 * Owned by exactly one writer at a time; callers mutate it only AFTER the
 * durable append committed, so a throw mid-append never desyncs it from the
 * log.
 *
 * THE PENDING LAYER (POD-3328). "After the append committed" is not the same
 * moment as "after the append's span returned". A write nested inside an
 * enclosing unit of work returns when its SAVEPOINT is released, and a released
 * savepoint is not a commit: the enclosing span can still roll back and take
 * the rows with it. So rows staged inside an open span go into
 * {@link stagePending} and reach the committed maps only through
 * {@link promotePending}, which the writer registers as a commit application on
 * the OUTERMOST commit (spec §3.3 mechanism 1). A batch whose span rolled back
 * is never promoted, and {@link discardPending} clears whatever a rollback left
 * behind the next time the writer is called with no span open.
 *
 * READS SEE THE PENDING LAYER, and that is not a convenience. `Authority.stage`
 * dedups against this baseline and DROPS a remove whose id the baseline does not
 * hold; a baseline that could not see the span's own earlier writes would drop
 * the remove half of a create-then-delete inside one span, leaving the log
 * claiming a row the transaction deleted. Deferring the fold without the overlay
 * would trade one divergence for another.
 */
export class ChangeBaseline {
  /** entity -> id -> DETECTION KEY of the last recorded state (see
   *  {@link detectionKey}: the stable-field projection for projected entities,
   *  else the serialized wire JSON). */
  private readonly last = new Map<MetadataEntityKind, Map<string, string>>()
  private readonly current = new Map<MetadataEntityKind, Map<string, unknown>>()
  /** Staged batches, in stage order. Empty whenever no span is open. */
  private readonly pending: PendingBatch[] = []
  private nextToken = 1

  private byEntity(entity: MetadataEntityKind): Map<string, string> {
    let m = this.last.get(entity)
    if (!m) {
      m = new Map()
      this.last.set(entity, m)
    }
    return m
  }

  private currentEntity(entity: MetadataEntityKind): Map<string, unknown> {
    let rows = this.current.get(entity)
    if (!rows) {
      rows = new Map()
      this.current.set(entity, rows)
    }
    return rows
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
        const value: unknown = JSON.parse(row.payload)
        this.byEntity(entity).set(row.entityId, detectionKey(entity, value, row.payload))
        this.currentEntity(entity).set(row.entityId, value)
      } catch {} // corrupt payload -> no baseline; first record re-upserts it
    }
  }

  /** Would upserting (id, value) change anything? Byte-equality on the
   *  entity's detection key (see {@link detectionKey}). */
  upsertChanged(entity: MetadataEntityKind, id: string, value: unknown, json: string): boolean {
    const staged = this.staged(entity, id)
    const key = detectionKey(entity, value, json)
    if (staged) return staged.op === 'remove' || staged.key !== key
    return this.byEntity(entity).get(id) !== key
  }

  has(entity: MetadataEntityKind, id: string): boolean {
    const staged = this.staged(entity, id)
    if (staged) return staged.op === 'upsert'
    return this.byEntity(entity).has(id)
  }

  /** Ids currently present in the baseline for one entity kind (remove-diff input). */
  ids(entity: MetadataEntityKind): string[] {
    const ids = new Set(this.byEntity(entity).keys())
    for (const batch of this.pending) {
      for (const row of batch.rows) {
        if (row.entity !== entity) continue
        if (row.op === 'upsert') ids.add(row.id)
        else ids.delete(row.id)
      }
    }
    return [...ids]
  }

  applyUpsert(entity: MetadataEntityKind, id: string, value: unknown, json: string): void {
    this.byEntity(entity).set(id, detectionKey(entity, value, json))
    this.currentEntity(entity).set(id, structuredClone(value))
  }

  applyRemove(entity: MetadataEntityKind, id: string): void {
    this.byEntity(entity).delete(id)
    this.currentEntity(entity).delete(id)
  }

  /** Current durable projection for global snapshot assembly. */
  values(entity: MetadataEntityKind): readonly unknown[] {
    const rows = new Map(this.currentEntity(entity))
    for (const batch of this.pending) {
      for (const row of batch.rows) {
        if (row.entity !== entity) continue
        if (row.op === 'upsert') rows.set(row.id, row.value)
        else rows.delete(row.id)
      }
    }
    return [...rows.values()].map((value) => structuredClone(value))
  }

  // -------------------------------------------------------------------------
  // The pending layer (POD-3328)
  // -------------------------------------------------------------------------

  /** Stage a batch against the OPEN span. Returns the token that promotes it. */
  stagePending(rows: readonly BaselineFold[]): number {
    const token = this.nextToken++
    this.pending.push({ token, rows })
    return token
  }

  /**
   * Fold one staged batch into the committed maps. Called from the commit
   * application of the span that staged it, so a batch whose span never
   * committed is simply never promoted.
   */
  promotePending(token: number): void {
    const index = this.pending.findIndex((batch) => batch.token === token)
    if (index === -1) return
    const [batch] = this.pending.splice(index, 1) as [PendingBatch]
    for (const row of batch.rows) this.apply(row)
  }

  /**
   * Drop everything staged. The writer calls this when it is about to stage or
   * read with NO span open: anything still here belongs to a span that ended
   * without promoting, which is a span that rolled back.
   */
  discardPending(): void {
    this.pending.length = 0
  }

  /** Fold a row that is already durable. */
  apply(row: BaselineFold): void {
    if (row.op === 'upsert') {
      this.byEntity(row.entity).set(row.id, row.key)
      this.currentEntity(row.entity).set(row.id, structuredClone(row.value))
    } else {
      this.byEntity(row.entity).delete(row.id)
      this.currentEntity(row.entity).delete(row.id)
    }
  }

  /** The last staged state for (entity, id), or undefined if none is staged. */
  private staged(entity: MetadataEntityKind, id: string): BaselineFold | undefined {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const rows = (this.pending[i] as PendingBatch).rows
      for (let j = rows.length - 1; j >= 0; j--) {
        const row = rows[j] as BaselineFold
        if (row.entity === entity && row.id === id) return row
      }
    }
    return undefined
  }
}

/**
 * The lowest seq the authority can still DELIVER (ADR 2 D5) — the published
 * retention horizon, so a replica can tell it must re-bootstrap BEFORE asking
 * rather than after being refused.
 *
 * The `?? max + 1` fallback is what makes the number TOTAL. A fully-pruned log
 * (every row aged out, `max` still 500 via sqlite_sequence) can deliver nothing
 * that exists, and the next change it writes will be 501 — so 501 is both true
 * and precise, where a null would need a special case at every consumer and a 0
 * would claim it can serve a cursor it cannot.
 *
 * The exact replica predicate is `cursor + 1 < minAvailableSeq` ⇒ re-bootstrap,
 * which is {@link readChangesSince}'s own servability rule read from the other
 * side: it can serve a cursor iff every change in (cursor, max] is retained,
 * i.e. iff `cursor + 1 >= minAvailableSeq`. Worth stating precisely because ADR
 * 2 D7 rung 2 gives the shorthand `cursor < minAvailableSeq` — the same rule off
 * by one, costing one needless re-bootstrap at exactly `cursor === min - 1`.
 * Both are SAFE (the authority's answer is authoritative either way; a needless
 * bootstrap is always legal), but the exact form is free.
 */
export function minAvailableSeq(
  store: Pick<ChangeLogStore, 'maxChangeSeq' | 'minChangeSeq'>,
): number {
  return store.minChangeSeq() ?? store.maxChangeSeq() + 1
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
      const base = { seq: r.seq, id: r.entityId, op: r.op }
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
