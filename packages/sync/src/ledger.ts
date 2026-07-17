import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import {
  CHANGE_KEEP_ROWS,
  CHANGE_MAX_AGE_MS,
  CHANGE_PRUNE_EVERY,
  ChangeBaseline,
  type ChangeLogStore,
  conversationProjection,
  pruneChangeLog,
  readChangesSince,
} from './change-log'

/**
 * Ledger — the durable metadata change log at the WRITE seam [spec:SP-3fe2]
 * (#253, P2a of the rebuild; the log's SINGLE writer since P2f #258 deleted
 * the legacy broadcast-seam MetadataOplog).
 *
 * Where the old oplog sat at the BROADCAST seam and inferred changes by
 * diffing full entity lists at fan-out time, the Ledger captures changes at
 * the moment they are made: {@link commit} runs the entity write and the
 * change append inside ONE injected `transact()` span, so "the entity row
 * changed" and "the change log says so" commit or roll back together.
 *
 * Mapping from the oplog.s `partial` flag (issue #22):
 * - `capture()` explicitly appends non-row mutations owned by a service seam.
 *   Like commit it never diffs a list; unlike commit it has no entity-row write
 *   to share a transaction with.
 * - `commit()` NEVER diffs lists. The `changes()` callback declares exactly
 *   what the write touched; a declared `remove` is explicit. There is no
 *   subset/full-list ambiguity, so `partial` does not exist here.
 * - The full-list remove-diff survives ONLY in {@link reconcile}: a boot-only
 *   pass fed the full truth for one entity kind, which diffs against the
 *   baseline INCLUDING removes — covering anything that changed or vanished
 *   while the server was down (the oplog's full-truth `record()` mode).
 *
 * Dedup (./change-log.ts): byte-equality on the
 * serialized wire JSON, except conversations, which compare on the
 * stable-field projection (updatedAt/messageCount/statusHint excluded from
 * DETECTION while the durable payload stays the full wire value — the
 * 81MB/day churn fix). No-op upserts and removes of ids the log never
 * recorded are dropped; a fully-deduped commit appends nothing.
 *
 * The in-memory baseline is mutated only after the transact span returns
 * successfully — a throw anywhere inside (write, changes(), append) rolls the
 * durable state back and leaves the baseline untouched.
 */

/** One declared entity change: what a write did, stated by the writer.
 *  `value` is the entity's WIRE shape (present iff op === 'upsert'). */
export interface EntityChangeSpec {
  entity: MetadataEntityKind
  id: string
  op: 'upsert' | 'remove'
  value?: unknown
}

export interface LedgerDeps {
  repo: ChangeLogStore
  now: () => number
  /** Runs fn atomically with any ambient entity write. INJECTED — the Ledger
   *  never imports the sqlite helper; composition wires it later (to the
   *  nesting-safe `transaction(db, fn)` over the shared connection). Unit
   *  tests may pass a pass-through `(fn) => fn()`. */
  transact: <T>(fn: () => T) => T
  /** Monotonic clock seam for deterministic maintenance scheduling tests. */
  monotonicNow?: () => number
  /** Records each retention job's total duration and max uninterrupted slice. */
  onPruneMetrics?: Parameters<typeof pruneChangeLog>[1]['onMetrics']
}

export interface LedgerBootOptions {
  repo: ChangeLogStore
  now: () => number
  signal?: AbortSignal
  monotonicNow?: () => number
  onPruneMetrics?: Parameters<typeof pruneChangeLog>[1]['onMetrics']
}

/**
 * Real-server readiness gate [spec:SP-c29e]: finish the sliced boot prune before
 * any Ledger construction can fold or reconcile the retained change log.
 */
export function prepareLedgerBoot(options: LedgerBootOptions) {
  return pruneChangeLog(options.repo, {
    keepRows: CHANGE_KEEP_ROWS,
    maxAgeMs: CHANGE_MAX_AGE_MS,
    now: options.now(),
    signal: options.signal,
    monotonicNow: options.monotonicNow,
    onMetrics: options.onPruneMetrics,
  })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** A staged (already deduped) change row awaiting append/baseline commit. */
interface StagedRow {
  entity: MetadataEntityKind
  entityId: string
  op: 'upsert' | 'remove'
  payload: string | null
  value?: unknown
}

export class Ledger {
  private readonly baseline = new ChangeBaseline()
  private appendsSincePrune = 0
  private readonly listeners = new Set<(changes: MetadataChange[]) => void>()
  private readonly shutdown = new AbortController()
  private pruneFlight: Promise<void> | undefined
  private pruneRerunRequested = false

  constructor(private readonly deps: LedgerDeps) {
    this.baseline.seed(deps.repo)
  }

  /**
   * THE write seam: runs `write()` and the change append inside ONE
   * `transact()` span. `changes(result)` declares what changed; dedup drops
   * no-op upserts (and removes of ids not in the baseline). Returns the write
   * result plus the appended wire rows (empty if fully deduped). A throw from
   * `write`, `changes`, or the append rolls everything back and leaves the
   * in-memory baseline untouched.
   */
  commit<T>(op: { write: () => T; changes: (result: T) => EntityChangeSpec[] }): {
    result: T
    changes: MetadataChange[]
  } {
    const { result, rows, seqs } = this.deps.transact(() => {
      const result = op.write()
      // An async write() would smuggle a Promise past transact()'s thenable
      // check (it's wrapped in this object, not returned directly): the change
      // row would commit now while the entity write ran later, OUTSIDE the
      // transaction — exactly the torn state commit() exists to prevent.
      if (isThenable(result)) {
        throw new TypeError(
          'Ledger.commit: write() returned a thenable — the entity write must be ' +
            'synchronous so it commits atomically with the change append.',
        )
      }
      const rows = this.stage(op.changes(result))
      const seqs = rows.length > 0 ? this.deps.repo.appendChanges(rows, this.deps.now()) : []
      return { result, rows, seqs }
    })
    return { result, changes: this.finalize(rows, seqs) }
  }

  /**
   * Capture an explicitly owned mutation that has no durable entity-row write
   * to bind to (for example volatile session view state or an upstream mirror).
   * The caller supplies the exact upserts/removes; this never diffs a full list.
   * Ledger seq remains the only durable/client-visible ordering primitive while
   * service-local generations merely schedule projection work. [spec:SP-c29e]
   */
  capture(specs: EntityChangeSpec[]): MetadataChange[] {
    const staged = this.stage(specs)
    const seqs = staged.length > 0 ? this.deps.repo.appendChanges(staged, this.deps.now()) : []
    return this.finalize(staged, seqs)
  }

  /**
   * Boot-only reconciliation: `rows` is the FULL truth for one entity kind.
   * Diffs against the baseline INCLUDING removes — the only surviving
   * full-list diff path — so changes made while the server was down land in
   * the log before the first client reads it. The append is atomic on its own
   * (no ambient entity write to bind to), so no transact span is opened.
   */
  reconcile(entity: MetadataEntityKind, rows: { id: string; value: unknown }[]): MetadataChange[] {
    const specs: EntityChangeSpec[] = rows.map((r) => ({
      entity,
      id: r.id,
      op: 'upsert',
      value: r.value,
    }))
    const listed = new Set(rows.map((r) => r.id))
    for (const id of this.baseline.ids(entity)) {
      if (!listed.has(id)) specs.push({ entity, id, op: 'remove' })
    }
    const staged = this.stage(specs)
    const seqs = staged.length > 0 ? this.deps.repo.appendChanges(staged, this.deps.now()) : []
    return this.finalize(staged, seqs)
  }

  /** Catch-up read for `sync.changesSince` — null means "fall back to a
   *  snapshot" (bootstrap / compacted-past-cursor / future cursor / corrupt row). */
  changesSince(cursor: number | null): MetadataChange[] | null {
    return readChangesSince(this.deps.repo, cursor)
  }

  /** Current cursor — the highest seq ever assigned (0 before any change). */
  cursor(): number {
    return this.deps.repo.maxChangeSeq()
  }

  /** Cancel maintenance between bounded units during server shutdown. */
  dispose(): void {
    this.pruneRerunRequested = false
    this.shutdown.abort()
  }

  /** Fires after commit/capture/reconcile with the appended changes (never with an
   *  empty batch). Per-listener try/catch so a listener throw can't break the
   *  committer. Returns an unsubscribe. */
  onAppended(listener: (changes: MetadataChange[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Dedup declared specs against the baseline, in order, tracking a
   * batch-local overlay so several specs for the same (entity, id) in one
   * batch compare against the batch's own staged state (e.g. first-sight
   * upsert followed by remove stages both, not just the upsert).
   */
  private stage(specs: EntityChangeSpec[]): StagedRow[] {
    const rows: StagedRow[] = []
    type Overlay = { op: 'upsert'; json: string; value: unknown } | { op: 'remove' }
    const overlay = new Map<string, Overlay>()
    for (const spec of specs) {
      const key = `${spec.entity} ${spec.id}`
      const prior = overlay.get(key)
      if (spec.op === 'upsert') {
        const json = JSON.stringify(spec.value)
        const changed = prior
          ? prior.op === 'remove' ||
            (spec.entity === 'conversation'
              ? conversationProjection(prior.value) !== conversationProjection(spec.value)
              : prior.json !== json)
          : this.baseline.upsertChanged(spec.entity, spec.id, spec.value, json)
        if (!changed) continue
        rows.push({
          entity: spec.entity,
          entityId: spec.id,
          op: 'upsert',
          payload: json,
          value: spec.value,
        })
        overlay.set(key, { op: 'upsert', json, value: spec.value })
      } else {
        const present = prior ? prior.op === 'upsert' : this.baseline.has(spec.entity, spec.id)
        if (!present) continue // remove of an id the log never recorded — no-op
        rows.push({ entity: spec.entity, entityId: spec.id, op: 'remove', payload: null })
        overlay.set(key, { op: 'remove' })
      }
    }
    return rows
  }

  /** Post-transact tail: fold the staged rows into the baseline (only now —
   *  the durable append has committed), build the wire rows, notify listeners,
   *  and only THEN attempt retention. Prune runs last and guarded: the commit
   *  is already durable, so a prune failure must degrade to a logged error —
   *  it must never make a committed write look failed to the caller or hide
   *  its changes from listeners. */
  private finalize(rows: StagedRow[], seqs: number[]): MetadataChange[] {
    if (rows.length === 0) return []
    for (const row of rows) {
      if (row.op === 'upsert') {
        this.baseline.applyUpsert(row.entity, row.entityId, row.value, row.payload as string)
      } else {
        this.baseline.applyRemove(row.entity, row.entityId)
      }
    }
    const changes = rows.map((row, i) => {
      const base = { seq: seqs[i] as number, id: row.entityId, op: row.op }
      return (
        row.op === 'upsert'
          ? { ...base, entity: row.entity, value: row.value }
          : { ...base, entity: row.entity }
      ) as MetadataChange
    })
    for (const listener of this.listeners) {
      try {
        listener(changes)
      } catch (err) {
        console.error('[ledger] onAppended listener threw', err)
      }
    }
    if (++this.appendsSincePrune >= CHANGE_PRUNE_EVERY) {
      this.appendsSincePrune = 0
      this.schedulePrune()
    }
    return changes
  }

  /**
   * [spec:SP-c29e] Coalesce overlapping cadence triggers into the current
   * retention flight plus at most one rerun.
   */
  private schedulePrune(): void {
    if (this.shutdown.signal.aborted) return
    if (this.pruneFlight) {
      this.pruneRerunRequested = true
      return
    }
    const flight = this.drainPruneRequests()
    this.pruneFlight = flight
    const clear = () => {
      if (this.pruneFlight === flight) this.pruneFlight = undefined
    }
    void flight.then(clear, (err) => {
      clear()
      console.error('[ledger] retention prune failed (writes remain durable)', err)
    })
  }

  private async drainPruneRequests(): Promise<void> {
    let failed = false
    let failure: unknown
    do {
      this.pruneRerunRequested = false
      try {
        const { metrics } = await pruneChangeLog(this.deps.repo, {
          keepRows: CHANGE_KEEP_ROWS,
          maxAgeMs: CHANGE_MAX_AGE_MS,
          now: this.deps.now(),
          signal: this.shutdown.signal,
          monotonicNow: this.deps.monotonicNow,
          onMetrics: this.deps.onPruneMetrics,
        })
        if (metrics.exceededPlacementThreshold) {
          console.warn(
            `[ledger] retention job took ${metrics.totalDurationMs.toFixed(1)}ms; ` +
              'candidate for janitor placement',
          )
        }
      } catch (err) {
        if (!failed) failure = err
        failed = true
      }
    } while (this.pruneRerunRequested && !this.shutdown.signal.aborted)
    if (failed) throw failure
  }
}
