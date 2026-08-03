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
 * ---------------------------------------------------------------------------
 * THE FEED IS SCOPED (POD-1077) — AND THE RANGE IS PART OF THE DELIVERY
 * ---------------------------------------------------------------------------
 *
 * Amendment 1 D12 overturned D2's unscoped clause: a replica's stream is the
 * subsequence of the one global feed its principal may see, and D12.7 puts the
 * evaluation HERE ("the authority evaluates visibility; the replica never
 * filters, never re-checks, and never receives a row it may not see").
 *
 * Both read paths of this role — `subscribe` and `changesSince` — therefore take
 * a PRINCIPAL and return a {@link ScopedDelivery}, which carries the evaluated
 * range beside the rows. There is no unscoped overload of either, because an
 * optional principal makes the unscoped read the default and the default is what
 * every new call site takes. `authority.scoped.test.ts` replaces the
 * `authority.unscoped.test.ts` tripwire POD-305 left here, assertion for
 * assertion.
 *
 * Nothing about the WRITE side moved. Scoping happens at read/fan-out and never
 * at append (D12.6), which is precisely why one global `seq` can stay global:
 * one log read still serves N principals, `minAvailableSeq` stays a single
 * published number, and `originId`/`causationId` stay meaningful across
 * principals.
 */

import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import { type Principal, principalRoutingId } from '@podium/protocol'
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
import type {
  FeedScopingGrade,
  FeedVisibilityPolicy,
  VisibilityAnchorPort,
} from '../feed/visibility'
import {
  DEFAULT_RESCOPE_THRESHOLD,
  scopeBatch,
  scopeBootstrap,
  type ScopedBootstrap,
  type ScopedDelivery,
} from './scoping'

export interface AuthorityDeps {
  /** The durable change log. Narrow by design — see `ChangeStorePort`. */
  store: ChangeLogStore
  /** ADR 1 D3's one legal arbitration clock, and the append's event time. */
  now: AuthorityClock
  /** ADR 2 D10's unit of work, injected. Unit tests may pass `(fn) => fn()`. */
  transact: TransactPort
  /**
   * ADR 2 Amendment 1 D12.7 — the per-principal evaluation, REQUIRED.
   *
   * Required rather than optional-defaulting-to-permissive, and that is the
   * decision: a default would make "no policy" indistinguishable from "everyone
   * may see everything", which is the fails-OPEN shape this run has paid for
   * repeatedly. A composition root that genuinely has one principal must SAY so
   * by naming `DeviceGradeUnscopedPolicy`, and `bun run audit:scoped-feed` holds
   * that name to its declared allowlist.
   */
  visibility: FeedVisibilityPolicy
  /** D14.3 — what turns a grant row into per-principal `evict`/re-admit rows. */
  anchors: VisibilityAnchorPort
  /** D14.4's terminal-path bound. Defaults to {@link DEFAULT_RESCOPE_THRESHOLD}. */
  rescopeThreshold?: number
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

/** One subscription: who it is for, and where its deliveries go. */
interface ScopedSubscription {
  readonly principal: Principal
  readonly deliver: ChangeSubscriber
}

export class Authority implements AuthorityPort {
  private readonly baseline = new ChangeBaseline()
  private readonly subscribers = new Set<ScopedSubscription>()

  constructor(private readonly deps: AuthorityDeps) {
    this.baseline.seed(deps.store)
  }

  /** Current durable values for one entity kind, used only for full snapshot assembly. */
  snapshot(entity: MetadataEntityKind): readonly unknown[] {
    return this.baseline.values(entity)
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

  /**
   * Catch-up read for ONE principal (Amendment 1 D13's certified reply).
   *
   * `throughSeq` is the LOG HEAD, not the last visible row's seq. A reply whose
   * range stopped at the last visible row would certify a range that ends where
   * the data ends — so every suppressed seq above it stays an unexplained hole,
   * the replica heals again, and the heal returns the same filtered rows. That
   * loop is the exact failure D2 named and D13 exists to prevent, and it is
   * reachable here rather than only on the live path because a heal is how a
   * replica recovers from every rung of the ladder.
   */
  changesSince(cursor: number | null, principal: Principal): ScopedDelivery | null {
    const rows = readChangesSince(this.deps.store, cursor)
    if (rows === null) return null
    return this.scope(principal, rows.map(fromWire), this.cursor())
  }

  cursor(): number {
    return this.deps.store.maxChangeSeq()
  }

  /**
   * The grade of the policy this Authority was CONSTRUCTED with (POD-376).
   *
   * One line, and it is a delegation rather than a stored copy on purpose: a
   * field set in the constructor would be a second place the answer lives, and a
   * policy swapped at any point would leave it stale in the direction that lets a
   * revoke-capable authority claim it cannot revoke.
   */
  visibilityGrade(): FeedScopingGrade {
    return this.deps.visibility.grade
  }

  /**
   * THE INSTALLED WORLD for one principal, at the current head (POD-1203).
   *
   * This is what makes bootstrap a FEED FEATURE rather than a parallel mechanism.
   * Before the serving-path cutover the server answered "what is there?" by
   * asking five features to rebuild their own full lists, and the delta stream
   * answered "what changed?" — two paths over one truth, agreeing by assumption.
   * Here both answers come out of the same log: the world is the latest retained
   * row per (entity, id), and the position it was read at is the same `cursor()`
   * the next delta certifies from.
   *
   * READ AT ONE POSITION, SYNCHRONOUSLY, AND THAT IS THE CONTIGUITY ARGUMENT.
   * `throughSeq` is taken in the same synchronous pass as the rows, and this role
   * appends only inside `commit`, so nothing can land between the two. A caller
   * that attaches a feed at this `throughSeq` therefore resumes exactly where the
   * world stopped — no window, and no `changesSince` round trip to discover where
   * it stands, which is what the v1 snapshot could never offer because its
   * message carried no position at all.
   */
  bootstrap(principal: Principal): ScopedBootstrap {
    const state: SequencedChange[] = []
    for (const row of this.deps.store.latestChangeStates()) {
      if (row.op !== 'upsert' || row.payload === null) continue
      try {
        state.push({
          seq: row.seq,
          entity: row.entity as MetadataEntityKind,
          entityId: row.entityId,
          op: 'upsert',
          value: JSON.parse(row.payload),
        })
      } catch {
        // A corrupt payload is skipped rather than failing the attach: the row is
        // unreadable for every consumer of the log (the dedup baseline skips it
        // for the same reason), and the next write of that entity re-upserts it
        // into every replica.
      }
    }
    return scopeBootstrap({ policy: this.deps.visibility }, principal, state, this.cursor())
  }

  /**
   * Amendment 1 D13.5's LIVENESS TICK: "I evaluated everything up to the head and
   * there is nothing for you."
   *
   * Produced by scoping an EMPTY batch through the same function every other
   * delivery goes through, rather than by a bespoke watermark constructor. That
   * is what makes a watermark structurally unable to skip a visible row: it is
   * the ordinary path with a filter that matched nothing, so there is no second
   * code path where someone could certify a range without evaluating it.
   *
   * D13.5 makes this normative rather than optional: under private-by-default a
   * replica's visible traffic is sparse, and one that is never watermarked
   * forward falls below `minAvailableSeq` and re-bootstraps for lack of news. The
   * CADENCE is POD-337's measured threshold; this is the operation it calls.
   */
  watermark(principal: Principal): ScopedDelivery {
    return this.scope(principal, [], this.cursor())
  }

  subscribe(principal: Principal, subscriber: ChangeSubscriber): () => void {
    const subscription: ScopedSubscription = { principal, deliver: subscriber }
    this.subscribers.add(subscription)
    return () => {
      this.subscribers.delete(subscription)
    }
  }

  /** The principals currently subscribed, by stable id. Telemetry and tests. */
  subscribedPrincipals(): readonly string[] {
    return [...this.subscribers].map((s) => principalRoutingId(s.principal))
  }

  /**
   * ONE evaluation site, used by BOTH read paths.
   *
   * Deliberately private and deliberately singular: a second scoping site would
   * be byte-identical on the wire in the common case and therefore invisible to
   * every golden fixture — a restatement is exactly the composition drift only a
   * single definition site can prevent. `authority.scoped.test.ts` asserts that
   * the live path and the heal path agree by DIFFING their output over the same
   * range rather than by asserting each against a literal.
   */
  private scope(
    principal: Principal,
    changes: readonly SequencedChange[],
    throughSeq: number,
  ): ScopedDelivery {
    return scopeBatch(
      {
        policy: this.deps.visibility,
        anchors: this.deps.anchors,
        rescopeThreshold: this.deps.rescopeThreshold ?? DEFAULT_RESCOPE_THRESHOLD,
      },
      principal,
      changes,
      throughSeq,
    )
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
        const present = prior
          ? prior.op === 'upsert'
          : this.baseline.has(spec.entity, spec.entityId)
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
  private finalize(
    rows: readonly StagedRow[],
    seqs: readonly number[],
  ): readonly SequencedChange[] {
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
        // The head of THIS batch, captured before any subscriber can commit
        // again. Reading `this.cursor()` inside the loop would certify a range
        // including seqs from a reentrant commit whose own batch has not been
        // delivered yet — a cursor advanced past data that is still queued, which
        // is the invisible permanent gap arriving through the ordering door
        // rather than the visibility one.
        const throughSeq = batch[batch.length - 1]?.seq ?? 0
        for (const subscription of this.subscribers) {
          try {
            // Evaluated PER SUBSCRIBER, inside the one ordered drain: N
            // principals see N slices of one batch, and never two orders of it.
            subscription.deliver(this.scope(subscription.principal, batch, throughSeq))
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
