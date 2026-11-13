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
 *    Writers name no records: the database captures which model rows the
 *    write changed, and the Authority builds the records those rows reach and
 *    appends each whole (POD-6920). No published copy is read by a write.
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

import { createLogger } from '@podium/logger'
import type { ChangeProvenanceFields } from '@podium/model'
import { type MetadataEntityKind, type Principal, principalRoutingId } from '@podium/protocol'
import { type ChangeLogStore, ChangeRangeBootstrapRequired } from '../change-log'
import type {
  FeedScopingGrade,
  FeedVisibilityPolicy,
  VisibilityAnchorPort,
} from '../feed/visibility'
import { arbitrate } from './arbitration'
import type { RecordIdsByKind } from '../record-builders'
import type { ScopedChange, SequencedChange, StagedChangeSpec } from './change-lifecycle'
import type {
  AuthorityClock,
  AuthorityCommit,
  AuthorityCommitOutcome,
  AuthorityPort,
  ChangeSubscriber,
  PostCommitFollowUpPort,
  ProvenancePort,
  RecordSourcePort,
  TransactPort,
} from './ports'
import {
  DEFAULT_RESCOPE_THRESHOLD,
  type PreparedBatch,
  prepareBatch,
  type ScopedBootstrap,
  type ScopedDelivery,
  type ScopingDeps,
  scopeBatch,
  scopeBootstrap,
  scopeChangesRange,
} from './scoping'

/** Both hosts, one namespace — see the note on `sync:ledger`. */
const log = createLogger('sync:authority')

export interface AuthorityDeps {
  /** The durable change log. Narrow by design — see `ChangeStorePort`. */
  store: ChangeLogStore
  /** ADR 1 D3's one legal arbitration clock, and the append's event time. */
  now: AuthorityClock
  /** ADR 2 D10's unit of work, injected. Unit tests may pass `(fn) => fn()`. */
  transact: TransactPort
  /**
   * Runs subscriber delivery once the OUTERMOST unit of work has committed
   * [POD-3260, spec §3.3 mechanism 3]. Optional; delivery is immediate without
   * it, which is what every test and the client adapters want.
   *
   * WHY IT IS NEEDED, and it is not the case the code was written for. `commit`
   * already broadcasts on the far side of ITS OWN span (step 4 below), which is
   * correct when that span is the whole transaction. It is not correct when this
   * commit is NESTED inside a caller's wider one — `IssueAttachOrchestrator`
   * wraps a whole attach in one `transact`, and every `ledger.commit` inside it
   * is a SAVEPOINT. "After my savepoint released" is not "after the transaction
   * committed": the outer body can still throw, and every subscriber has already
   * been told about changes the database then rolls back.
   */
  postCommit?: PostCommitFollowUpPort
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
  /**
   * The command now appending (ADR 2 D8; POD-6272). Read once per `commit`. Unset means no row is stamped, which is
   * what every caller outside the write entry point gets.
   */
  provenance?: ProvenancePort
  /**
   * Current records built from model tables, and which of them a write
   * changed (the drained capture, POD-6920), for the append, bootstrap and
   * access checks. Required: a log cannot answer current-state reads.
   */
  records: RecordSourcePort
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

/** A staged, already-deduped row awaiting append. */
interface StagedRow {
  spec: StagedChangeSpec
  payload: string | null
}

/** One record as built from the database: its value and its serialized form. */
interface BuiltState {
  readonly value: unknown
  readonly json: string
}

/** One subscription: who it is for, and where its deliveries go. */
interface ScopedSubscription {
  readonly principal: Principal
  readonly deliver: ChangeSubscriber
}

/**
 * The DEFINED fields of a provenance group, or `undefined` when it names none.
 * One place decides "absent stays absent": a field reported or spread as
 * `undefined` is not a key on the stored row, the broadcast or the read.
 */
function definedProvenance(
  p: ChangeProvenanceFields | undefined,
): ChangeProvenanceFields | undefined {
  if (p === undefined) return undefined
  const out: ChangeProvenanceFields = {}
  if (p.originId !== undefined) out.originId = p.originId
  if (p.causationId !== undefined) out.causationId = p.causationId
  if (p.mutationId !== undefined) out.mutationId = p.mutationId
  return out.originId === undefined && out.causationId === undefined && out.mutationId === undefined
    ? undefined
    : out
}

/**
 * Each spec with its provenance group settled: its OWN group when it names any
 * field (the whole group, so an ambient field is never grafted onto a writer's
 * explicit provenance), else the ambient one, else none.
 */
function stampProvenance(
  specs: readonly StagedChangeSpec[],
  ambient: ChangeProvenanceFields | undefined,
): StagedChangeSpec[] {
  return specs.map((spec) => {
    const { originId, causationId, mutationId, ...rest } = spec
    const own = definedProvenance({ originId, causationId, mutationId })
    const group = own ?? ambient
    return group === undefined ? rest : { ...rest, ...group }
  })
}

export class Authority implements AuthorityPort {
  private readonly subscribers = new Set<ScopedSubscription>()

  constructor(private readonly deps: AuthorityDeps) {}

  /** Current values from the model tables, in the caller's snapshot. */
  async snapshot(entity: MetadataEntityKind): Promise<readonly unknown[]> {
    const values: unknown[] = []
    for await (const page of this.deps.records.streamAll(entity)) {
      for (const record of page) values.push(record.value)
    }
    return values
  }

  /** Current values of exactly these ids; a missing model record is absent. */
  async installedValues(
    entity: MetadataEntityKind,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, unknown>> {
    const out = new Map<string, unknown>()
    if (ids.length === 0) return out
    for (const record of await this.deps.records.build(entity, ids))
      out.set(record.id, record.value)
    return out
  }

  async commit<T>(op: AuthorityCommit<T>): Promise<AuthorityCommitOutcome<T>> {
    // The causing command, read ONCE and before the first await, so the answer
    // is the caller's even if the write awaits into another context.
    const ambient = this.ambientProvenance()

    // 1. AUTHORIZE. Before anything reads state, and a throw ends the call.
    await op.authorize?.()

    // 2. ARBITRATE + 3. WRITE + APPEND, one span. The current-state hook runs
    //    INSIDE this transaction, immediately before the write, so arbitration
    //    is an atomic check-and-write rather than a best-effort preflight.
    //
    //    The Authority stamps the event time here: ADR 1 D3 condition 1 makes
    //    its own clock the only one a field-LWW row may arbitrate on, and the
    //    port has nowhere for a caller to supply a different one.
    const eventTime = this.deps.now()
    // Where this commit starts in the capture: what an enclosing write
    // captured before it is that write's to drain, not this commit's.
    const mark = (await this.deps.records.captureMark?.()) ?? 0
    const body = async () => {
      if (op.arbitrate !== undefined) {
        const { current, ...request } = op.arbitrate
        const verdict = arbitrate({
          ...request,
          attempt: { ...request.attempt, eventTime },
          ...(current === undefined ? {} : { current: await current() }),
        })
        if (verdict.kind === 'reject') {
          return verdict.detail === undefined
            ? ({ outcome: 'rejected', reason: verdict.reason } as const)
            : ({ outcome: 'rejected', reason: verdict.reason, detail: verdict.detail } as const)
        }
      }

      // DERIVED CHANGE CAPTURE (POD-6253 design §3, POD-6920): the write
      // names nothing. The database captured every model row the transaction
      // changed since this commit started; draining it answers the records
      // those rows reach, and
      // each is built as it is now, in this span, so nothing else can write
      // between the build and the append.
      const result = await op.write()
      const rows = await this.stageTouched(await this.deps.records.drainCapture(mark), ambient)
      const seqs = rows.length > 0 ? await this.append(rows, eventTime) : []
      const changes = await this.finalize(rows, seqs)
      return { outcome: 'committed', result, changes } as const
    }
    const records = this.deps.records
    const committed = await this.deps.transact(async () =>
      records.inCommit === undefined ? await body() : await records.inCommit(body),
    )

    if (committed.outcome === 'rejected') return committed

    // 4. BROADCAST — after the span, so no subscriber can act on a rolled-back
    //    change.
    return {
      outcome: 'committed',
      result: committed.result,
      changes: committed.changes,
    }
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
  async changesSince(cursor: number | null, principal: Principal): Promise<ScopedDelivery | null> {
    if (cursor === null) return null
    const through = await this.captureHead()
    const changes: ScopedChange[] = []
    try {
      for await (const delivery of this.changesRange(principal, cursor, through, 1_000)) {
        if (delivery.kind === 'rescope') return delivery
        changes.push(...delivery.changes)
      }
    } catch (error) {
      if (error instanceof ChangeRangeBootstrapRequired) return null
      throw error
    }
    return { kind: 'batch', throughSeq: through, changes }
  }

  async captureHead(): Promise<number> {
    return await this.deps.store.maxChangeSeq()
  }

  async *changesRange(
    principal: Principal,
    from: number,
    through: number,
    pageRows: number,
  ): AsyncIterable<ScopedDelivery & { readonly fromSeq: number }> {
    yield* scopeChangesRange(
      this.deps.store,
      this.scopingDeps(),
      principal,
      from,
      through,
      pageRows,
    )
  }

  async cursor(): Promise<number> {
    return await this.captureHead()
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
   * Current model records stamped with the feed head. The caller owns the
   * read snapshot across the head and the stream (the sync worker does so).
   * No current-state read depends on catch-up retention.
   */
  async bootstrap(principal: Principal): Promise<ScopedBootstrap> {
    const head = await this.cursor()
    const state: SequencedChange[] = []
    for await (const { entity, records: page } of this.deps.records.streamAllKinds()) {
      for (const record of page) {
        state.push({ seq: head, entity, entityId: record.id, op: 'upsert', value: record.value })
      }
    }
    return await scopeBootstrap({ policy: this.deps.visibility }, principal, state, head)
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
  async watermark(principal: Principal): Promise<ScopedDelivery> {
    return await this.scope(principal, [], await this.cursor())
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
  private async scope(
    principal: Principal,
    changes: readonly SequencedChange[],
    throughSeq: number,
    prepared?: PreparedBatch,
  ): Promise<ScopedDelivery> {
    return await scopeBatch(
      this.scopingDeps(),
      principal,
      changes,
      throughSeq,
      // Absent — `watermark` and the single-principal paths — `scopeBatch`
      // prepares its own for this one principal.
      prepared,
    )
  }

  private scopingDeps(): ScopingDeps {
    return {
      policy: this.deps.visibility,
      anchors: this.deps.anchors,
      rescopeThreshold: this.deps.rescopeThreshold ?? DEFAULT_RESCOPE_THRESHOLD,
    }
  }

  // -------------------------------------------------------------------------
  // Derived change capture (POD-6253 design §3, POD-6920)
  // -------------------------------------------------------------------------

  /**
   * One row per touched record, in the order the capture reached them: an
   * upsert of the record as the database holds it now, or a remove when it
   * is gone. There is no build before the write and no compare: a record the
   * capture reached is appended whole.
   */
  private async stageTouched(
    touched: RecordIdsByKind,
    ambient: ChangeProvenanceFields | undefined,
  ): Promise<StagedRow[]> {
    if (touched.size === 0) return []
    const built = new Map<string, BuiltState>()
    for await (const { entity, records: page } of this.deps.records.buildMany(touched)) {
      for (const record of page) {
        built.set(entityOverlayKey(entity, record.id), {
          value: record.value,
          json: JSON.stringify(record.value),
        })
      }
    }
    const specs: StagedChangeSpec[] = []
    const payloads: (string | null)[] = []
    for (const [entity, ids] of touched) {
      for (const entityId of ids) {
        const now = built.get(entityOverlayKey(entity, entityId))
        if (now === undefined) {
          specs.push({ entity, entityId, op: 'remove' })
          payloads.push(null)
        } else {
          specs.push({ entity, entityId, op: 'upsert', value: now.value })
          payloads.push(now.json)
        }
      }
    }
    return stampProvenance(specs, ambient).map((spec, i) => ({
      spec,
      payload: payloads[i] as string | null,
    }))
  }

  /** The ambient command's provenance, with undefined fields dropped. */
  private ambientProvenance(): ChangeProvenanceFields | undefined {
    return definedProvenance(this.deps.provenance?.current())
  }

  private async append(rows: readonly StagedRow[], eventTime: number): Promise<number[]> {
    return await this.deps.store.appendChanges(
      rows.map((r) => ({
        entity: r.spec.entity,
        entityId: r.spec.entityId,
        op: r.spec.op,
        payload: r.payload,
        // Already settled by `stampProvenance`; passed through as stored.
        ...definedProvenance(r.spec),
      })),
      eventTime,
    )
  }

  /**
   * Post-span tail: build the sequenced rows and notify after commit.
   *
   * Per-subscriber try/catch: the changes are already durable, so a subscriber
   * throwing must not make a committed write look failed to its caller, and must
   * not stop the subscribers after it in the set from being told.
   */
  private async finalize(
    rows: readonly StagedRow[],
    seqs: readonly number[],
  ): Promise<readonly SequencedChange[]> {
    if (rows.length === 0) return []
    const changes: SequencedChange[] = rows.map((row, i) => ({
      ...row.spec,
      seq: seqs[i] as number,
    }))
    // The DELIVERY is mechanism 3 and waits for the outermost commit when the
    // adapter can tell us when that is (see {@link AuthorityDeps.postCommit}).
    if (this.deps.postCommit) {
      this.deps.postCommit(async () => {
        await this.broadcast(changes)
      }, 'authority-broadcast')
    } else {
      await this.broadcast(changes)
    }
    return changes
  }

  // -------------------------------------------------------------------------
  // THE ORDERED PIPE (#247, #256) — one queue, append order, always
  // -------------------------------------------------------------------------

  private broadcastTail: Promise<void> = Promise.resolve()

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
   * The promise tail makes arrival order equal append order NO MATTER what a
   * subscriber does: a reentrant commit joins the tail, which reaches it only
   * after batch N has reached everyone.
   *
   * Per-subscriber try/catch, because the changes are ALREADY DURABLE: a throw
   * must not make a committed write look failed to its caller, and must not stop
   * the subscribers after it in the set from being told. A reconnecting client
   * heals through `changesSince`; a silently skipped subscriber does not.
   * Preparation itself remains outside that isolation: unresolved rights fail
   * the whole pass closed instead of leaking a row to any subscriber.
   */
  private async broadcast(changes: readonly SequencedChange[]): Promise<void> {
    const delivery = this.broadcastTail.then(async () => {
      // The head and visibility snapshot belong to THIS pass. Preparation is an
      // awaited producer step under the writer lease; only its resolved policy
      // and edges enter the synchronous per-subscriber loop.
      const throughSeq = changes[changes.length - 1]?.seq ?? 0
      const prepared = await prepareBatch(this.scopingDeps(), changes)
      for (const subscription of this.subscribers) {
        try {
          subscription.deliver(
            await this.scope(subscription.principal, changes, throughSeq, prepared),
          )
        } catch (err) {
          log.error('change subscriber threw', { throughSeq, err })
        }
      }
    })
    // A failed preparation denies this pass, but it must not poison every later
    // batch. The caller still awaits `delivery` and observes the original error.
    this.broadcastTail = delivery.catch(() => undefined)
    await delivery
  }
}
