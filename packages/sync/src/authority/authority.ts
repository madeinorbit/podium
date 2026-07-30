/**
 * THE AUTHORITY — the write funnel and the Ledger, as one kernel role (POD-305).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY THEY HAD TO BECOME ONE THING
 * ---------------------------------------------------------------------------
 *
 * Two halves of one pipeline lived in two packages and two layers:
 *
 *   `apps/server/src/modules/funnel.ts`  authorize → write, and the ordered
 *                                        metadataDelta pipe that broadcasts.
 *   `packages/sync/src/ledger.ts`        the transactional entity-write +
 *                                        change-append, and the cursor reads.
 *
 * The funnel could not enforce its own ordering rule, because the append it was
 * ordering happened inside the Ledger and reached it through a listener. The
 * Ledger could not enforce "authorize first", because authorization was a step
 * its caller had already taken — or had not. "Every mutation flows authorize →
 * write → change-append → broadcast, in that order and nowhere else" was true by
 * the convention that every call site used the funnel, and it was one direct
 * `ledger.commit()` away from being false. Joining them makes the sentence
 * structural: there is one entry point, and the order is the body of one method.
 *
 * The half that stayed behind is the LEGACY SNAPSHOT TAIL — `publishComputed`,
 * full-entity-list fan-out to pre-delta clients. That is a transport concern of
 * one app, POD-308 deletes it at the wire cutover, and pulling it into the kernel
 * would have been the opposite of this issue.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHY NO STEP IN IT IS NEGOTIABLE
 * ---------------------------------------------------------------------------
 *
 * 1. AUTHORIZE. A throw stops everything. The write is unreachable past it, so
 *    "a forbidden op must never write" is a property of control flow rather than
 *    of every caller remembering. Resolved live by the caller over the delegation
 *    chain (ADR 3 D8/D16) — the Authority does not resolve principals, it makes
 *    the question unskippable.
 * 2. ARBITRATE. Per the row's DECLARED conflict rule (ADR 1 D2/D3), before the
 *    write, so a rejected write leaves no entity change to undo. Authorization
 *    precedes it because a principal who may not write at all must be refused
 *    without learning anything about the row's revision — a rejection carries a
 *    reason and a denial must not.
 * 3. WRITE + APPEND, in ONE transact span (ADR 2 D10). "The entity row changed"
 *    and "the change log says so" commit or roll back together, which is why the
 *    feed can never disagree with the tables.
 * 4. BROADCAST. After the span, never inside it: a subscriber must not be able to
 *    observe — or worse, act on — a change that a later throw rolls back.
 *
 * ---------------------------------------------------------------------------
 * ARBITRATION LIVES HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * ADR 1 D1. The Replica applies an ordering this role decided; it never merges,
 * never invents LWW, and never overrides a revision. `check-boundaries` rule 9
 * direction-locks `../replica/`, and `arbitration-direction.test.ts` fails if a
 * file outside the Authority-side allowlist imports the matrix's conflict reads.
 * Both of those are tripwires on the IMPORT, which catches the mistake when it is
 * written rather than when a merge goes wrong in production.
 *
 * WHAT THIS ROLE STILL DOES NOT DO, stated so a green suite is not misread:
 * the feed is UNSCOPED. Every subscriber receives every change. Per-principal
 * filtering, watermarks and `evict` are POD-1077's, and ADR 2 Amendment 1 D13 is
 * explicit that a filter without a watermark is a protocol break — so they land
 * together, and not here. `authority.unscoped.test.ts` pins the absence as a
 * TEST, so nobody can read this file's silence as privacy.
 */

import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import { ChangeBaseline, type ChangeLogStore, detectionKey, readChangesSince } from '../change-log'
import { arbitrate } from './arbitration'
import type { StagedChangeSpec, SequencedChange } from './change-lifecycle'
import type {
  AuthorityClock,
  AuthorityCommit,
  AuthorityCommitOutcome,
  AuthorityPort,
  ChangeSubscriber,
  TransactPort,
} from './ports'

export interface AuthorityDeps {
  /** The durable change log. Narrow by design — see `ChangeStorePort`. */
  store: ChangeLogStore
  /** ADR 1 D3's one legal arbitration clock, and the append's event time. */
  now: AuthorityClock
  /** ADR 2 D10's unit of work, injected. Unit tests may pass `(fn) => fn()`. */
  transact: TransactPort
}

/**
 * Composite overlay key for (entity, id). The separator is a real NUL at runtime
 * — it cannot occur in an entity name or an id, so keys never collide — but it is
 * written as an ESCAPE deliberately. A literal NUL BYTE in the source makes
 * `file`, grep and friends classify the module as binary, and plain grep then
 * reports NOTHING and exits 1 rather than erroring: a fail-OPEN shape, and the
 * one this repository has already been bitten by twice (POD-758, POD-296).
 */
export function entityOverlayKey(entity: string, id: string): string {
  return `${entity}\u0000${id}`
}

/** A staged, already-deduped row awaiting append and baseline commit. */
interface StagedRow {
  spec: StagedChangeSpec
  payload: string | null
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export class Authority implements AuthorityPort {
  private readonly baseline = new ChangeBaseline()
  private readonly subscribers = new Set<ChangeSubscriber>()

  constructor(private readonly deps: AuthorityDeps) {
    this.baseline.seed(deps.store)
  }

  commit<T>(op: AuthorityCommit<T>): AuthorityCommitOutcome<T> {
    // 1. AUTHORIZE. Before anything reads state, and a throw ends the call.
    op.authorize?.()

    // 2. ARBITRATE. Before the write, so a rejection leaves nothing to undo. The
    //    Authority stamps the event time here: ADR 1 D3 condition 1 makes its own
    //    clock the only one a field-LWW row may arbitrate on, and the port has
    //    nowhere for a caller to supply a different one.
    const eventTime = this.deps.now()
    if (op.arbitrate !== undefined) {
      const verdict = arbitrate({
        ...op.arbitrate,
        attempt: { ...op.arbitrate.attempt, eventTime },
      })
      if (verdict.kind === 'reject') {
        return verdict.detail === undefined
          ? { outcome: 'rejected', reason: verdict.reason }
          : { outcome: 'rejected', reason: verdict.reason, detail: verdict.detail }
      }
    }

    // 3. WRITE + APPEND, one span.
    const { result, rows, seqs } = this.deps.transact(() => {
      const result = op.write()
      // An async write() smuggles a Promise past transact()'s own thenable check
      // — it is wrapped in this object, not returned directly — so the change row
      // would commit now while the entity write ran later, OUTSIDE the
      // transaction. That is exactly the torn state the span exists to prevent,
      // and it fails loudly here rather than silently at 3am.
      if (isThenable(result)) {
        throw new TypeError(
          'Authority.commit: write() returned a thenable — the entity write must be synchronous ' +
            'so it commits atomically with the change append (ADR 2 D10).',
        )
      }
      const rows = this.stage(op.changes(result))
      const seqs = rows.length > 0 ? this.append(rows, eventTime) : []
      return { result, rows, seqs }
    })

    // 4. BROADCAST — after the span, so no subscriber can act on a rolled-back
    //    change.
    return { outcome: 'committed', result, changes: this.finalize(rows, seqs) }
  }

  capture(specs: readonly StagedChangeSpec[]): readonly SequencedChange[] {
    const eventTime = this.deps.now()
    const staged = this.stage(specs)
    const seqs = staged.length > 0 ? this.append(staged, eventTime) : []
    return this.finalize(staged, seqs)
  }

  reconcile(
    entity: MetadataEntityKind,
    rows: readonly { readonly id: string; readonly value: unknown }[],
  ): readonly SequencedChange[] {
    const specs: StagedChangeSpec[] = rows.map((r) => ({
      entity,
      entityId: r.id,
      op: 'upsert',
      value: r.value,
    }))
    const listed = new Set(rows.map((r) => r.id))
    // The full-list REMOVE diff — the only one left in the system, and the reason
    // reconcile exists at all: an entity deleted while the Authority was down has
    // no write to have declared it, so the truth of "what is here now" is the
    // only evidence that it went.
    for (const id of this.baseline.ids(entity)) {
      if (!listed.has(id)) specs.push({ entity, entityId: id, op: 'remove' })
    }
    const eventTime = this.deps.now()
    const staged = this.stage(specs)
    const seqs = staged.length > 0 ? this.append(staged, eventTime) : []
    return this.finalize(staged, seqs)
  }

  changesSince(cursor: number | null): readonly SequencedChange[] | null {
    const rows = readChangesSince(this.deps.store, cursor)
    return rows === null ? null : rows.map(fromWire)
  }

  cursor(): number {
    return this.deps.store.maxChangeSeq()
  }

  subscribe(subscriber: ChangeSubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  // -------------------------------------------------------------------------
  // Staging and dedup
  // -------------------------------------------------------------------------

  /**
   * Dedup declared specs against the baseline, IN ORDER, tracking a batch-local
   * overlay so several specs for one (entity, id) in one batch compare against
   * the batch's own staged state — a first-sight upsert followed by a remove
   * stages both, not just the upsert.
   *
   * Dedup is byte-equality on the serialized wire JSON, except conversations,
   * which compare on a stable-field projection (`updatedAt`/`messageCount`/
   * `statusHint` excluded from DETECTION while the durable payload stays the full
   * value — the 81MB/day churn fix). A no-op upsert and a remove of an id the log
   * never recorded are both dropped, so a fully-deduped commit appends nothing.
   */
  private stage(specs: readonly StagedChangeSpec[]): StagedRow[] {
    const rows: StagedRow[] = []
    type Overlay = { op: 'upsert'; json: string; value: unknown } | { op: 'remove' }
    const overlay = new Map<string, Overlay>()
    for (const spec of specs) {
      const key = entityOverlayKey(spec.entity, spec.entityId)
      const prior = overlay.get(key)
      if (spec.op === 'upsert') {
        const json = JSON.stringify(spec.value)
        const changed = prior
          ? prior.op === 'remove' ||
            detectionKey(spec.entity, prior.value, prior.json) !==
              detectionKey(spec.entity, spec.value, json)
          : this.baseline.upsertChanged(spec.entity, spec.entityId, spec.value, json)
        if (!changed) continue
        rows.push({ spec, payload: json })
        overlay.set(key, { op: 'upsert', json, value: spec.value })
      } else {
        const present = prior ? prior.op === 'upsert' : this.baseline.has(spec.entity, spec.entityId)
        if (!present) continue
        rows.push({ spec, payload: null })
        overlay.set(key, { op: 'remove' })
      }
    }
    return rows
  }

  private append(rows: readonly StagedRow[], eventTime: number): number[] {
    return this.deps.store.appendChanges(
      rows.map((r) => ({
        entity: r.spec.entity,
        entityId: r.spec.entityId,
        op: r.spec.op,
        payload: r.payload,
      })),
      eventTime,
    )
  }

  /**
   * Post-span tail: fold the staged rows into the baseline — ONLY now, because
   * the durable append has committed and a throw anywhere inside the span must
   * leave the in-memory baseline untouched — then build the sequenced rows and
   * notify.
   *
   * Per-subscriber try/catch: the changes are already durable, so a subscriber
   * throwing must not make a committed write look failed to its caller, and must
   * not stop the subscribers after it in the set from being told.
   */
  private finalize(rows: readonly StagedRow[], seqs: readonly number[]): readonly SequencedChange[] {
    if (rows.length === 0) return []
    for (const row of rows) {
      if (row.spec.op === 'upsert') {
        this.baseline.applyUpsert(
          row.spec.entity,
          row.spec.entityId,
          row.spec.value,
          row.payload as string,
        )
      } else {
        this.baseline.applyRemove(row.spec.entity, row.spec.entityId)
      }
    }
    const changes: SequencedChange[] = rows.map((row, i) => ({
      ...row.spec,
      seq: seqs[i] as number,
    }))
    this.broadcast(changes)
    return changes
  }

  // -------------------------------------------------------------------------
  // THE ORDERED PIPE (#247, #256) — one queue, append order, always
  // -------------------------------------------------------------------------

  private readonly pendingBatches: (readonly SequencedChange[])[] = []
  private draining = false

  /**
   * Deliver a batch to every subscriber, in APPEND ORDER, even under reentrancy.
   *
   * THE BUG THIS SHAPE EXISTS TO PREVENT, which a naive loop reintroduces and no
   * ordinary test notices: a subscriber that commits again — a projection that
   * writes a derived row, a mirror that folds — re-enters this method from inside
   * the notification of batch N. With a plain `for (const s of subscribers)` the
   * inner batch N+1 is delivered to EVERY subscriber before the outer loop
   * reaches subscriber B, so B observes [N-1, N+1, N].
   *
   * That is not a cosmetic reorder. Delta clients apply the gap rule
   * `seq !== cursor + 1 → heal`, so B's cursor advances past N and the heal
   * storm that follows is permanent: `changesSince` returns the same rows in the
   * same order forever. `funnel.ts` fixed it once by enqueueing before emitting;
   * the fix moves here with the pipe rather than being rediscovered.
   *
   * The queue makes arrival order equal append order NO MATTER what a subscriber
   * does: a reentrant commit pushes its batch and returns immediately, and the
   * outer drain picks it up only after batch N has reached everyone.
   *
   * Per-subscriber try/catch, because the changes are ALREADY DURABLE: a throw
   * must not make a committed write look failed to its caller, and must not stop
   * the subscribers after it in the set from being told. A reconnecting client
   * heals through `changesSince`; a silently skipped subscriber does not.
   */
  private broadcast(changes: readonly SequencedChange[]): void {
    this.pendingBatches.push(changes)
    if (this.draining) return
    this.draining = true
    try {
      while (this.pendingBatches.length > 0) {
        const batch = this.pendingBatches.shift() as readonly SequencedChange[]
        for (const subscriber of this.subscribers) {
          try {
            subscriber(batch)
          } catch (err) {
            console.error('[authority] change subscriber threw', err)
          }
        }
      }
    } finally {
      this.draining = false
    }
  }
}

/** The stored/wire row as a sequenced kernel change. */
function fromWire(change: MetadataChange): SequencedChange {
  const base = { seq: change.seq, entity: change.entity, entityId: change.id, op: change.op }
  return change.op === 'upsert' ? { ...base, value: change.value } : base
}
