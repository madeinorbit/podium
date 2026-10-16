import { type MetadataChange, MetadataEntityKind } from '@podium/protocol'
import { runTimeBudgetedJob, type TimeBudgetedJobMetrics } from '@podium/runtime/time-budget'
import type { ChangeLogReadRow, ChangeLogWriteRow } from './authority/change-lifecycle'

/**
 * Internals of the durable metadata change log [spec:SP-3fe2] (#253): change
 * detection against the stored rows, the conversation significance projection, the retention
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
  appendChanges(rows: readonly ChangeLogWriteRow[], eventTime: number): Promise<number[]>
  /** Highest seq ever assigned (survives head-pruning). 0 = none. */
  maxChangeSeq(): Promise<number>
  /** Lowest RETAINED seq, or null when the log is empty. */
  minChangeSeq(): Promise<number | null>
  /** Plain range read: rows with seq > cursor, in seq order. */
  changesSince(cursor: number): Promise<readonly ChangeLogReadRow[]>
  /** Rows in (from, through], ascending and bounded by limit. */
  changesInRange(from: number, through: number, limit: number): Promise<readonly ChangeLogReadRow[]>
  /** Snapshot the head-only retention threshold once per job. */
  planChangePrune(opts: {
    keepRows: number
    maxAgeMs: number
    now: number
  }): Promise<ChangePrunePlan>
  /** Delete one bounded, indexed head batch from a fixed plan. */
  pruneChangeBatch(plan: ChangePrunePlan, batchSize: number): Promise<number>
  /** THE INSTALLED WORLD — the latest live state per (entity, id): the bootstrap
   *  read (see
   *  `ChangeStorePort.latestChangeStates`). Independent of retention (POD-678):
   *  the row budget bounds what `changesSince` can serve, never what exists. Only
   *  `upsert` rows come back — a removed entity is not in the world. */
  latestChangeStates(): Promise<readonly ChangeLogReadRow[]>
  /** The installed rows of these keys, in no particular order; a key with no
   *  installed row is absent. One grouped read: what a commit's dedup reads
   *  inside its own span [POD-6156]. */
  installedStates(
    keys: readonly { readonly entity: string; readonly entityId: string }[],
  ): Promise<readonly ChangeLogReadRow[]>
  /** Every installed row of one entity kind, in seq order [POD-6156]. */
  installedStatesOf(entity: string): Promise<readonly ChangeLogReadRow[]>
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
    async () => {
      if (!plan) {
        plan = await store.planChangePrune({
          keepRows: opts.keepRows,
          maxAgeMs: opts.maxAgeMs,
          now: opts.now,
        })
        return plan.thresholdSeq > 0 ? 'continue' : 'done'
      }
      const batchDeleted = await store.pruneChangeBatch(plan, CHANGE_PRUNE_BATCH_ROWS)
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

/** The change-DETECTION key for one entity value: the stable-field projection
 *  for entities with churn-prone derived fields, else the full serialized wire
 *  JSON (`json` must be `JSON.stringify(value)`). */
export function detectionKey(entity: MetadataEntityKind, value: unknown, json: string): string {
  if (entity === 'conversation') return conversationProjection(value)
  return json
}

/**
 * The detection key of a stored payload, or `undefined` for a corrupt one: a
 * payload that does not parse, or one the entity's projection cannot read. A
 * corrupt row counts as "not there" [POD-6156]: its next upsert re-records it
 * and a remove of it is dropped.
 */
export function storedKeyOf(entity: MetadataEntityKind, payload: string | undefined): string | undefined {
  if (payload === undefined) return undefined
  try {
    return detectionKey(entity, JSON.parse(payload), payload)
  } catch {
    return undefined
  }
}

/**
 * Would upserting `value` (serialized as `json`) change the stored row? Byte
 * equality on the detection key, read from the stored payload [POD-6156]. A
 * full-JSON key needs no parse: an equal payload is unchanged and any other
 * payload is changed. Only a projected key (a conversation's stable fields)
 * parses the stored payload.
 */
export function differsFromStored(
  entity: MetadataEntityKind,
  payload: string | undefined,
  value: unknown,
  json: string,
): boolean {
  if (payload === undefined) return true
  if (payload === json) return false
  const key = detectionKey(entity, value, json)
  if (key === json) return true
  return storedKeyOf(entity, payload) !== key
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
 * which is {@link readChangesRange}'s own servability rule read from the other
 * side: it can serve a cursor iff every change in (cursor, max] is retained,
 * i.e. iff `cursor + 1 >= minAvailableSeq`. Worth stating precisely because ADR
 * 2 D7 rung 2 gives the shorthand `cursor < minAvailableSeq` — the same rule off
 * by one, costing one needless re-bootstrap at exactly `cursor === min - 1`.
 * Both are SAFE (the authority's answer is authoritative either way; a needless
 * bootstrap is always legal), but the exact form is free.
 */
export async function minAvailableSeq(
  store: Pick<ChangeLogStore, 'maxChangeSeq' | 'minChangeSeq'>,
): Promise<number> {
  return (await store.minChangeSeq()) ?? (await store.maxChangeSeq()) + 1
}

/** A range cannot be certified; the caller must request a bootstrap. */
export class ChangeRangeBootstrapRequired extends Error {
  constructor(readonly reason: 'compacted-or-unknown' | 'corrupt-payload') {
    super(reason)
    this.name = 'ChangeRangeBootstrapRequired'
  }
}

/** Read a fixed target in bounded pages, checking retention once before reading. */
export async function* readChangesRange(
  store: Pick<ChangeLogStore, 'minChangeSeq' | 'changesInRange'>,
  from: number,
  through: number,
  pageRows: number,
): AsyncIterable<MetadataChange[]> {
  if (!Number.isSafeInteger(pageRows) || pageRows <= 0)
    throw new RangeError('pageRows must be positive')
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from < 0 || from > through) {
    throw new ChangeRangeBootstrapRequired('compacted-or-unknown')
  }
  if (from === through) return
  const min = await store.minChangeSeq()
  if (min == null || min > from + 1) throw new ChangeRangeBootstrapRequired('compacted-or-unknown')
  while (from < through) {
    const rows = await store.changesInRange(from, through, pageRows)
    if (rows.length === 0) return
    const changes: MetadataChange[] = []
    for (const r of rows) {
      if (!MetadataEntityKind.safeParse(r.entity).success) continue
      const base = { seq: r.seq, id: r.entityId, op: r.op, entity: r.entity as MetadataEntityKind }
      if (r.op === 'upsert') {
        if (r.payload == null) throw new ChangeRangeBootstrapRequired('corrupt-payload')
        let value: unknown
        try {
          value = JSON.parse(r.payload)
        } catch {
          throw new ChangeRangeBootstrapRequired('corrupt-payload')
        }
        changes.push({ ...base, value } as MetadataChange)
      } else {
        changes.push(base as MetadataChange)
      }
    }
    from = rows[rows.length - 1]!.seq
    yield changes
  }
}
