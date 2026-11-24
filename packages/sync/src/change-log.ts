import { MetadataEntityKind } from '@podium/protocol'
import { runTimeBudgetedJob, type TimeBudgetedJobMetrics } from '@podium/runtime/time-budget'
import type {
  ChangeLogReadRow,
  ChangeLogWriteRow,
  SequencedChange,
} from './authority/change-lifecycle'

/**
 * Internals of the durable metadata change log (#253): change
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
/** POD-7585 — one change-log row by name: its seq, kind and id. */
export interface ChangeRef {
  readonly seq: number
  readonly entity: string
  readonly entityId: string
}

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
  /**
   * POD-7585 — the same range, naming each row only (no payloads): what a
   * replay of the access moves evaluates. Absent, the replay reads
   * {@link changesInRange}.
   */
  changeRefsInRange?(from: number, through: number, limit: number): Promise<readonly ChangeRef[]>
  /** Snapshot the head-only retention threshold once per job. */
  planChangePrune(opts: {
    keepRows: number
    maxAgeMs: number
    now: number
  }): Promise<ChangePrunePlan>
  /** Delete one bounded, indexed head batch from a fixed plan. */
  pruneChangeBatch(plan: ChangePrunePlan, batchSize: number): Promise<number>
}

/** Per-feed retention: at most 500,000 rows and 30 days, whichever removes more.
 *  This database currently has one feed; hosting partitions both budgets by tenant. */
export { CHANGE_KEEP_ROWS, CHANGE_MAX_AGE_MS } from '@podium/protocol'
/** Delete-unit bound, measured below the 12ms slice target on representative rows. */
export const CHANGE_PRUNE_BATCH_ROWS = 100

export interface ChangeLogPruneResult {
  deleted: number
  metrics: TimeBudgetedJobMetrics
}

/**
 * Drain eligible change-log rows in bounded delete units under the shared
 * monotonic/macrotask budget. This function deliberately does
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

/**
 * POD-7593 — whether the log still holds every change above `from`, read from
 * {@link ChangeLogStore.minChangeSeq} in one statement. It is
 * {@link minAvailableSeq}'s rule `from + 1 >= floor` for a caller that needs
 * rows: such a caller asks for `(from, through]` with `from < through <= head`,
 * so a null floor (a fully pruned log, floor `head + 1`) always refuses, and
 * never reads as "nothing pruned".
 */
export async function retainsAfter(
  store: Pick<ChangeLogStore, 'minChangeSeq'>,
  from: number,
): Promise<boolean> {
  const floor = await store.minChangeSeq()
  return floor !== null && floor <= from + 1
}

/** A range cannot be certified; the caller must request a bootstrap. */
export class ChangeRangeBootstrapRequired extends Error {
  constructor(readonly reason: 'compacted-or-unknown' | 'corrupt-payload') {
    super(reason)
    this.name = 'ChangeRangeBootstrapRequired'
  }
}

/**
 * Read a fixed target in bounded pages, checking retention after every page.
 *
 * POD-7589 — THE FLOOR IS READ AFTER EACH PAGE, NOT ONCE BEFORE THE FIRST. A
 * prune ({@link ChangeLogStore.pruneChangeBatch}) that commits while a heal reads
 * deletes rows the next page would have returned, and a page read cannot tell a
 * deleted row from one that never existed: it starts at the lowest survivor and
 * the client's cursor would pass the rows it never received. The prune moves the
 * floor in the same transaction as its delete, so a floor read AFTER a page sees
 * every prune that committed before that page was read. A floor above
 * `pageStart + 1` therefore means the page may be missing rows, and the read
 * throws {@link ChangeRangeBootstrapRequired} BEFORE yielding it: the answer is a
 * re-bootstrap, never a partial delta. A prune that commits after the floor read
 * cannot have removed rows the page already returned. Read inside a snapshot (the
 * sync worker), the floor cannot move and the check always passes.
 *
 * The same read covers a cursor already below the floor: the first page is read
 * and refused. Both callers refuse that case up front instead (POD-7593): the
 * worker from its snapshot's feed state, the live authority with
 * {@link retainsAfter} before the first page, so no payloads are read for a
 * cursor the log cannot serve.
 *
 * Yields KERNEL rows ({@link SequencedChange}): `entityId`, the parsed value, and
 * the provenance exactly as stored (POD-6272). It used to yield the pre-cutover
 * wire `MetadataChange`, which has no provenance and spells the id `id`, and its
 * one caller renamed the id back.
 */
export async function* readChangesRange(
  store: Pick<ChangeLogStore, 'minChangeSeq' | 'changesInRange'>,
  from: number,
  through: number,
  pageRows: number,
): AsyncIterable<SequencedChange[]> {
  if (!Number.isSafeInteger(pageRows) || pageRows <= 0)
    throw new RangeError('pageRows must be positive')
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from < 0 || from > through) {
    throw new ChangeRangeBootstrapRequired('compacted-or-unknown')
  }
  if (from === through) return
  while (from < through) {
    const rows = await store.changesInRange(from, through, pageRows)
    // After the page, before it is used: see the doc comment above.
    if (!(await retainsAfter(store, from)))
      throw new ChangeRangeBootstrapRequired('compacted-or-unknown')
    if (rows.length === 0) return
    const changes: SequencedChange[] = []
    for (const r of rows) {
      if (!MetadataEntityKind.safeParse(r.entity).success) continue
      const base: SequencedChange = {
        seq: r.seq,
        entity: r.entity as MetadataEntityKind,
        entityId: r.entityId,
        op: r.op,
      }
      // Absent stays absent: the store maps a NULL column to no key.
      if (r.originId !== undefined) base.originId = r.originId
      if (r.causationId !== undefined) base.causationId = r.causationId
      if (r.mutationId !== undefined) base.mutationId = r.mutationId
      if (r.op === 'upsert') {
        if (r.payload == null) throw new ChangeRangeBootstrapRequired('corrupt-payload')
        let value: unknown
        try {
          value = JSON.parse(r.payload)
        } catch {
          throw new ChangeRangeBootstrapRequired('corrupt-payload')
        }
        changes.push({ ...base, value })
      } else {
        changes.push(base)
      }
    }
    from = rows[rows.length - 1]!.seq
    yield changes
  }
}
