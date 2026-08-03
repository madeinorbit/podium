/**
 * The Outbox role of the sync kernel (Phase 2, POD-306 family): durable command
 * delivery with the FULL ADR 3 D9 lifecycle, including the transitions that get
 * work back OUT of dead-letter. A dead-letter surface with no recovery leg is a
 * leak, not a lifecycle.
 *
 * ## Delivery semantics — at-least-once, deduped into effectively-once
 *
 * The Outbox is **at-least-once**. It cannot be exactly-once: a `sending` entry
 * whose reply is lost is indistinguishable from one that never arrived, so the
 * only safe move is to replay it (D9 invariant 4). What makes that harmless is
 * the client-minted `mutationId`: inside the Authority's receipt window a replay
 * returns the stored result WITHOUT re-running (ADR 3 D11.7), which is
 * effectively-once. Outside that window a replay would be a FRESH command
 * (D11.8 — `sessions.sendText` double-typing into a live PTY is the concrete
 * hazard), which is why entries expire before their receipts do: expiry at the
 * replica is how we refuse that send. The inequality
 * `OUTBOX_MAX_AGE_MS + SKEW_MARGIN_MS < RECEIPT_RETENTION_MS` and its
 * import-the-constant invariant are D10/D11 numbers, and they live in `limits.ts`
 * (POD-371) — this module still takes `maxAgeMs` as configuration and never mints
 * a default, because the inequality is against a constant `packages/*` cannot
 * import (boundary rule 4). The invariant test that supplies the real receipt
 * constant therefore sits on the server side of that boundary.
 *
 * ## Retry (D10)
 *
 * A transient failure is retried an UNLIMITED number of times, spaced by
 * exponential backoff (`nextAttemptAt`), until the age limit ends it: there is no
 * global attempt ceiling, because a ceiling converts user work into silent
 * failure. A DEFINITIVE refusal — including an authorization denial, which is
 * permanent because D8 resolves the delegation chain live — gets zero automatic
 * retries and dead-letters at once, so it neither burns the age limit nor holds
 * the head of its partition.
 *
 * ## Ordering
 *
 * FIFO **within** an ordering partition, concurrent **across** partitions
 * (D12). Global head-of-line blocking is forbidden; a blocked or dead-lettered
 * entry blocks only its own partition, until recovery or cancel.
 *
 * ## One writer, and it stages before it commits
 *
 * Every mutation goes through `mutate()`, which (a) SERIALIZES against every
 * other mutation, (b) builds a DRAFT of the record set, (c) writes the draft to
 * the store, and only then (d) adopts it in memory and emits its events. So a
 * failed or denied write (ADR 6 D4.4 quota: "the failing operation does not
 * partially apply") leaves memory exactly as it was, two concurrent `enqueue`
 * calls cannot commit out of order, and observability never runs ahead of
 * durability (D4.3). Removals inside a draft must carry one of D9 invariant 1's
 * two licences or the draft refuses to commit — see `OutboxDraft`.
 *
 * ## What this module deliberately cannot do
 *
 * - It cannot hold a secret: `enqueue` accepts only `offline-eligible` commands,
 *   and D4 rule 1 makes `secret` policy imply `online-sensitive` (POD-352).
 * - It cannot hold a capability, an "allow" bit or any rights snapshot, so a
 *   replay cannot re-present stale rights. Re-authorization is the Authority's,
 *   live over the delegation chain, at every apply (D8 / amendment D16).
 * - It cannot show one principal another principal's work: the instance is BOUND
 *   to its authenticated principal, and every observation API is scoped to it
 *   (private-by-default, readiness §3.1.1). A caller cannot even ask.
 * - It cannot drop user-authored work. Every path out of the store is either a
 *   user action or an `applied` retirement after covering truth (D9 invariant 1),
 *   with exactly one exception: a genuinely unreadable store, which is loud
 *   (ADR 2 D7).
 */

import type { MutationId } from '@podium/model'
import {
  type BackoffPolicy,
  backoffDelayMs,
  isDefinitiveFailure,
  resolveMaxAgeMs,
  TRANSIENT_BACKOFF,
} from './limits'
import type {
  OutboxConfig,
  OutboxEnvelope,
  OutboxEvent,
  OutboxRecordExpectation,
  OutboxStoreMutation,
  OutboxStorePort,
  OutboxSubmitOutcome,
  SyncSpan,
} from './ports'
import {
  MAX_AGE_REASON,
  normalizeRefusal,
  type OutboxRejectionReason,
  type RetrySatisfaction,
  recoveryPlanFor,
  satisfies,
} from './reasons'
import {
  belongsTo,
  CONFIRMED,
  collapseKeyOf,
  confirmationOf,
  type DeadLetterRecord,
  ENQUEUEABLE_DELIVERY,
  type EnvelopeConfirmation,
  type OutboxAttribution,
  type OutboxCommand,
  type OutboxRecord,
  revisionOf,
  revisionOfValue,
  type UserRef,
} from './records'
import { applyOutboxTransition, nextOutboxState, type OutboxTransition } from './states'

export interface EnqueueRequest extends EnvelopeConfirmation {
  readonly command: OutboxCommand
  readonly input: unknown
  /**
   * The principal the entry is authored under, taken from the AUTHENTICATED
   * TRANSPORT by the caller (ADR 3 D7 / amendment D14, D17). It is a separate
   * argument from `input` on purpose: identity that arrives inside a payload is
   * inert by decision, and the Outbox has no code path that reads one.
   *
   * Its `onBehalfOf` half must equal the principal this Outbox is BOUND to —
   * one authenticated principal per instance. Enqueueing for somebody else is
   * refused, so an instance cannot become a mixed queue whose privacy depends on
   * every reader filtering correctly.
   */
  readonly attribution: OutboxAttribution
  readonly expectedRevision?: number
  /** ADR 3 D12. Defaults to a private `create:<mutationId>` partition, which is
   *  D12's own rule for additive commands with no existing target id — so an
   *  unpartitioned entry can never block another aggregate. */
  readonly partitionKey?: string
  /**
   * POD-785. Declares this write REDUNDANT once a later write with the same key
   * is queued in the same partition. Omit it — the default — and the entry is
   * never collapsed.
   *
   * Only the contract knows this. A read receipt is subsumed by a later read
   * receipt for the same issue; a line of text typed into a live PTY is not
   * subsumed by anything, and a PARTIAL patch is not subsumed by a later partial
   * patch (collapsing two `settings.updatePersonal` calls would drop the fields
   * only the first one set). So this is supplied per enqueue, never derived here.
   */
  readonly collapseKey?: string
  /** Supply one to keep a caller-minted id; otherwise the config mints it. */
  readonly mutationId?: MutationId
}

export interface EditRequest {
  readonly input: unknown
  readonly expectedRevision?: number
}

/** Thrown for a caller mistake: an illegal recovery, an unknown id, a delivery
 *  class the Outbox may not hold, an enqueue for another principal. Distinct
 *  from an Authority refusal, which is never an exception — it is a state. */
export class OutboxUsageError extends Error {}

/**
 * Thrown when a draft tries to remove a record without a licence. This is not a
 * caller error — it is a KERNEL INVARIANT BREACH, so it is a distinct type that
 * nothing catches: D9 invariant 1 allows an entry to become gone only by a user
 * action or by an `applied` retirement after covering truth, and any other
 * deletion (a future `flush`, a stray `filter` inside a maintenance path) must
 * fail loudly at the moment it is written rather than silently eat user work.
 */
export class OutboxInvariantError extends Error {}

/**
 * A mutation lost a race with another instance or tab: the record moved before the
 * write landed. Not a bug and not the caller's mistake — it means "re-read and
 * decide again", which the drain does by stopping its partition for this pass.
 */
export class OutboxStaleError extends Error {}

/** Internal: the store refused a mutation because a precondition no longer held.
 *  `mutate` re-stages against fresh truth; it never escapes to a caller. */
class OutboxConflict extends Error {
  constructor(readonly conflicts: readonly MutationId[]) {
    super(`outbox store conflict on ${conflicts.join(', ')}`)
  }
}

/** How many times a mutation re-stages against fresh truth before giving up. A
 *  bound rather than a loop: a permanent conflict must surface, not spin. */
const MUTATION_CONFLICT_ATTEMPTS = 5

/**
 * The licences to make an entry gone. Every one of them is D9 invariant 1's
 * "user action or an applied retirement" — none is an exception to it.
 */
export type RemovalLicence =
  /** A successful `applied` retirement after covering truth landed. */
  | 'covering-truth'
  /** The user discarded it (or re-issued it under a fresh id, which is the same
   *  decision: they chose for this entry to stop existing). */
  | 'user-discarded'
  /**
   * POD-785. A LATER write, authored by the same principal, still `queued` in the
   * same partition, carrying the same `collapseKey`, fully expresses this entry's
   * intent.
   *
   * This is invariant 1's USER-ACTION arm and not a third kind of thing: the act
   * that ends this entry is the user's own next click on the same state cell. The
   * intent is not discarded, it is REPRESENTED — by a record that is still in the
   * queue, still drains, and still lands. What is dropped is a duplicate of a
   * value the queue already holds, so no reader can tell the difference except by
   * the queue being smaller.
   *
   * That argument only holds under all four conditions, and `collapseInto` checks
   * every one of them rather than trusting a caller:
   *
   *  1. the contract OPTED IN via `collapseKey`, so a content-bearing command
   *     (text into a PTY) and a partial patch (which a later patch does not
   *     subsume) can never be reached;
   *  2. both entries are `queued` — never one that is `sending`/`accepted`, whose
   *     record is the only trace of a send the Authority may already hold, and
   *     never one in `dead-letter`, which is a refusal the user still has to see;
   *  3. the same partition, because ordering is only defined within one (D12) and
   *     a cross-partition collapse would be asserting an order we were not given;
   *  4. the same principal, which `mine()` already scopes.
   *
   * Loosen any of those and the removal stops being licensed. The tests that pin
   * each one are in `capacity.test.ts`.
   */
  | 'superseded'

/**
 * A staged edit of the record set.
 *
 * The reason this exists rather than mutating an array in place: it makes the
 * removal rule STRUCTURAL. `commit()` diffs the ids it started with against the
 * ids it ends with, and every id that disappeared must have been removed through
 * `remove(id, licence)`. A deletion introduced anywhere else — a `filter` slipped
 * into a maintenance routine, a `destroy()` added next year — cannot reach the
 * store, because the draft refuses to commit. That is a stronger guard than
 * asserting method NAMES: a name-based check passes a method called `flush`.
 */
class OutboxDraft {
  readonly events: OutboxEvent[] = []
  private readonly licensed = new Map<MutationId, RemovalLicence>()
  /** Ids this draft inserted or replaced, and ids it removed. */
  private readonly touched = new Set<MutationId>()
  private readonly removed = new Set<MutationId>()
  private records: OutboxRecord[]

  constructor(private readonly before: readonly OutboxRecord[]) {
    this.records = [...before]
  }

  all(): readonly OutboxRecord[] {
    return this.records
  }

  find(mutationId: MutationId): OutboxRecord | undefined {
    return this.records.find((r) => r.mutationId === mutationId)
  }

  /** Insert, or replace in place so FIFO position survives a state change. */
  put(record: OutboxRecord): void {
    const idx = this.records.findIndex((r) => r.mutationId === record.mutationId)
    if (idx === -1) this.records.push(record)
    else this.records[idx] = record
    this.touched.add(record.mutationId)
    this.removed.delete(record.mutationId)
  }

  remove(mutationId: MutationId, licence: RemovalLicence): void {
    this.licensed.set(mutationId, licence)
    this.records = this.records.filter((r) => r.mutationId !== mutationId)
    this.removed.add(mutationId)
    this.touched.delete(mutationId)
  }

  /**
   * What this draft BELIEVED about every record it touched, for the store to check
   * atomically with the write. Without these the read-modify-write interleaves with
   * another instance or tab (ADR 6 D4.6).
   */
  expectations(): readonly OutboxRecordExpectation[] {
    const ids = new Set<MutationId>([...this.touched, ...this.removed])
    return [...ids].map((id) => {
      const was = this.before.find((r) => r.mutationId === id)
      return { mutationId: id, expect: was ? was.state : ('absent' as const) }
    })
  }

  /**
   * The RECORD-LEVEL changes this draft makes — what goes to the store.
   *
   * Sending a delta rather than a snapshot is what stops a writer with a stale
   * base from deleting rows it never knew about: another principal's queued work
   * on a shared store, or an earlier retirement enrolled in the same span.
   */
  delta(): OutboxStoreMutation {
    const put = [...this.touched]
      .map((id) => this.records.find((r) => r.mutationId === id))
      .filter((r): r is OutboxRecord => r !== undefined)
    const mutation: OutboxStoreMutation = {
      // Written DIRECTLY rather than through conditional spreads: a key supplied
      // inside a spread escapes excess-property checking, so a renamed or deleted
      // port field would keep being emitted with nothing going red. An empty array
      // is semantically identical to an absent one for both `put` and `remove`.
      put,
      remove: [...this.removed],
      // Built HERE rather than by the caller, so a mutation cannot be assembled
      // without its preconditions — the hole the reviewer asked to close.
      expect: this.expectations(),
    }
    const keys = new Set([
      ...(mutation.put ?? []).map((r) => r.mutationId),
      ...(mutation.remove ?? []),
    ])
    const covered = new Set(mutation.expect.map((e) => e.mutationId))
    const uncovered = [...keys].filter((id) => !covered.has(id))
    if (uncovered.length > 0) {
      throw new OutboxInvariantError(
        `mutation would touch ${uncovered.join(', ')} with no precondition — that is an unconditional apply`,
      )
    }
    return mutation
  }

  emit(event: OutboxEvent): void {
    this.events.push(event)
  }

  /** The validated record set, or a loud failure. */
  sealed(): readonly OutboxRecord[] {
    const after = new Set(this.records.map((r) => r.mutationId))
    const vanished = this.before.filter((r) => !after.has(r.mutationId)).map((r) => r.mutationId)
    const unlicensed = vanished.filter((id) => !this.licensed.has(id))
    if (unlicensed.length > 0) {
      throw new OutboxInvariantError(
        `unlicensed outbox removal of ${unlicensed.join(', ')} — D9 invariant 1 permits "gone" only on user action or an applied retirement after covering truth`,
      )
    }
    // The mirror of the removal rule for INSERTS and EDITS: a record that appeared
    // or changed without going through `put()` would be adopted into memory and
    // never written, because the delta is built from what `put()` tracked. Memory
    // silently ahead of the store is the same defect class as an unlicensed
    // removal, so it fails the same way.
    const untracked = this.records
      .filter((r) => {
        const was = this.before.find((b) => b.mutationId === r.mutationId)
        return (was === undefined || was !== r) && !this.touched.has(r.mutationId)
      })
      .map((r) => r.mutationId)
    if (untracked.length > 0) {
      throw new OutboxInvariantError(
        `record(s) ${untracked.join(', ')} changed without going through put() — the store would never see them`,
      )
    }
    const phantom = [...this.licensed.keys()].filter((id) => after.has(id))
    if (phantom.length > 0) {
      throw new OutboxInvariantError(
        `removal licence claimed but ${phantom.join(', ')} still present`,
      )
    }
    return this.records
  }
}

export class Outbox {
  private readonly config: OutboxConfig
  private readonly store: OutboxStorePort
  /** The authenticated principal this instance belongs to. Every observation API
   *  is scoped to it; see `EnqueueRequest.attribution`. */
  private readonly principal: UserRef
  /** Insertion order IS the FIFO order within a partition. Replaced wholesale by
   *  `mutate()` — never mutated in place, so a rollback is an assignment. */
  private records: readonly OutboxRecord[]
  private readonly listeners = new Set<(event: OutboxEvent) => void>()
  private draining: Promise<void> | null = null
  /** The serialization chain. Every mutation queues behind the previous one, so
   *  two concurrent `enqueue` calls cannot interleave stage-and-write and commit
   *  out of order. */
  private mutations: Promise<unknown> = Promise.resolve()
  /** Per-span accumulated view and staged events, so several outbox changes in
   *  ONE transaction compose instead of overwriting each other. */
  private readonly spanDeltas = new WeakMap<SyncSpan, OutboxStoreMutation[]>()
  private readonly spanEvents = new WeakMap<SyncSpan, OutboxEvent[]>()

  private readonly backoff: BackoffPolicy

  private constructor(config: OutboxConfig, records: readonly OutboxRecord[]) {
    this.config = config
    this.store = config.store
    this.principal = config.principal
    this.records = records
    this.backoff = config.backoff ?? TRANSIENT_BACKOFF
    // D10: a per-command override may only SHORTEN. Checked HERE, at open, so a
    // config that would lengthen an entry past D11's inequality fails before it
    // has queued anything — rather than at the moment the first such command is
    // enqueued, hours later, in front of a user.
    for (const [command, override] of Object.entries(config.commandMaxAgeMs ?? {})) {
      resolveMaxAgeMs(config.maxAgeMs, command, override)
    }
    if (config.onEvent) this.listeners.add(config.onEvent)
  }

  /**
   * Hydrate from the durable store and reconcile whatever a crash left behind.
   *
   * Two recoveries happen here, both of them consequences of D9 rather than
   * choices:
   *
   * - `sending` / `accepted` return to `queued`. A drain attempt that never
   *   reported back is the transport failure of invariant 4, and the replay is
   *   safe because the `mutationId` is unchanged (D11.7).
   * - a `rejected` / `expired` record is parked. Invariant 2 says those states
   *   ALWAYS enter dead-letter; a crash in that window must not leave an entry
   *   resolved-but-unrecoverable.
   *
   * Records belonging to another principal are loaded and left ALONE: not
   * observable here, not drained here, and above all not dropped — they are that
   * principal's unsent writes and only their own bound instance may resolve them.
   */
  static async open(config: OutboxConfig): Promise<Outbox> {
    let loaded: readonly OutboxRecord[] = []
    let unreadable: { error: unknown } | undefined
    try {
      loaded = await config.store.read()
    } catch (error) {
      unreadable = { error }
    }
    const outbox = new Outbox(config, [...loaded])
    if (unreadable) {
      // ADR 2 D7: the sole case where user work is lost, and it must be loud.
      // We continue as a cold outbox rather than wedging boot (ADR 6 D4.5), but
      // the caller is told, through a REQUIRED callback and an event.
      config.onStoreUnreadable(unreadable.error)
      outbox.emit({ type: 'store-unreadable', error: unreadable.error })
      return outbox
    }
    await outbox.reconcileOnOpen()
    return outbox
  }

  subscribe(listener: (event: OutboxEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** This instance's principal — the one whose work it may see and drain. */
  boundTo(): UserRef {
    return this.principal
  }

  /** Every record THIS PRINCIPAL authored, in FIFO order. Another principal's
   *  entries in the same physical store are invisible here by construction, not
   *  by a filter the caller has to remember. */
  all(): readonly OutboxRecord[] {
    return this.mine()
  }

  find(mutationId: MutationId): OutboxRecord | undefined {
    return this.mine().find((r) => r.mutationId === mutationId)
  }

  /** The optimistic-overlay input (POD-372): entries this principal has authored
   *  that the Authority has not applied yet. */
  pending(): readonly OutboxRecord[] {
    return this.mine().filter(
      (r) => r.state === 'queued' || r.state === 'sending' || r.state === 'accepted',
    )
  }

  /**
   * The recovery surface. It takes NO principal argument: the instance is bound
   * to one authenticated principal, so there is no query another user could
   * phrase to reach this author's work (private-by-default, readiness §3.1.1).
   * A dead-letter entry belongs to the human it was authored on behalf of — the
   * actor may be a retired agent session (§3.1.3 A4).
   */
  deadLetters(): readonly DeadLetterRecord[] {
    return this.mine()
      .filter((r) => r.state === 'dead-letter')
      .map((r) => toDeadLetterRecord(r))
  }

  /**
   * Durably queue one command. Resolves only after the store commit, and the
   * `local-ack` event fires after that — a local ack that outran its own
   * durability would be a lie, and ADR 6 D4.3 puts these records in the same
   * durability class as entity rows.
   */
  async enqueue(request: EnqueueRequest): Promise<OutboxRecord> {
    if (request.command.delivery !== ENQUEUEABLE_DELIVERY) {
      // D4 rule 3 + D4 rule 1: `online-only` / `online-sensitive` must not be
      // outbox-exposed, and `secret` policy forces `online-sensitive`. Refusing
      // here — before any persistence — is what makes "secrets are never
      // queued" structural (POD-352).
      throw new OutboxUsageError(
        `command ${request.command.name} is ${String(request.command.delivery)}; only ${ENQUEUEABLE_DELIVERY} commands may enter the outbox`,
      )
    }
    if (request.attribution.onBehalfOf !== this.principal) {
      throw new OutboxUsageError(
        `this outbox is bound to ${this.principal}; it cannot enqueue work on behalf of ${request.attribution.onBehalfOf}`,
      )
    }
    return await this.mutate((draft) => {
      const mutationId = request.mutationId ?? this.config.newMutationId()
      // Uniqueness is checked against the WHOLE store, not just this principal's
      // slice: a `mutationId` is the Authority's dedupe key, so a collision
      // across principals would be just as wrong.
      if (draft.find(mutationId)) {
        throw new OutboxUsageError(`duplicate mutationId in outbox: ${mutationId}`)
      }
      const record: OutboxRecord = {
        mutationId,
        command: request.command,
        input: request.input,
        ...revisionOf(request),
        partitionKey: request.partitionKey ?? `create:${mutationId}`,
        ...collapseKeyOf(request),
        attribution: request.attribution,
        state: 'queued',
        queuedAt: this.config.now(),
        attempts: 0,
        ...confirmationOf(request),
      }
      draft.put(record)
      draft.emit({ type: 'local-ack', mutationId })
      // AFTER the put, so the successor is already in the draft: the entries
      // being removed are redundant BECAUSE this one exists, and staging it
      // first means there is no instant, even inside the transaction, where the
      // intent is represented by nothing.
      this.collapseInto(draft, record)
      return record
    })
  }

  /**
   * POD-785. Drop the queued predecessors this record supersedes.
   *
   * The four conditions on the `superseded` licence are enforced HERE, in the one
   * place that issues it, rather than being asked of callers. `record` itself is
   * excluded by id, so a re-entrant call could not collapse the very entry it was
   * staged for.
   */
  private collapseInto(draft: OutboxDraft, record: OutboxRecord): void {
    const key = record.collapseKey
    // No key means the contract never opted in — the default, and the only
    // setting a content-bearing command may have.
    if (key === undefined) return
    for (const candidate of draft.all()) {
      if (candidate.mutationId === record.mutationId) continue
      if (candidate.collapseKey !== key) continue
      if (candidate.partitionKey !== record.partitionKey) continue
      // `queued` ONLY. A `sending`/`accepted` entry may already be at the
      // Authority, and a `dead-letter` one is a refusal awaiting the user.
      if (candidate.state !== 'queued') continue
      if (!belongsTo(candidate, this.principal)) continue
      draft.remove(candidate.mutationId, 'superseded')
      draft.emit({ type: 'superseded', mutationId: candidate.mutationId })
    }
  }

  /**
   * One drain pass. Single-flight: concurrent callers await the same pass, so a
   * reconnect burst cannot double-submit the head of a partition.
   *
   * Partitions run concurrently; each partition is strictly FIFO and stops at
   * its first unresolved entry (D12).
   */
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainPass().finally(() => {
        this.draining = null
      })
    }
    return this.draining
  }

  private async drainPass(): Promise<void> {
    const partitions = new Map<string, OutboxRecord[]>()
    // Only this principal's work: another principal's entries drain under their
    // own bound instance, over their own authenticated transport.
    for (const record of this.mine()) {
      const bucket = partitions.get(record.partitionKey)
      if (bucket) bucket.push(record)
      else partitions.set(record.partitionKey, [record])
    }
    await Promise.all([...partitions.values()].map((bucket) => this.drainPartition(bucket)))
  }

  private async drainPartition(bucket: readonly OutboxRecord[]): Promise<void> {
    for (const snapshot of bucket) {
      // Re-read: a previous iteration (or an out-of-band apply notification)
      // may have moved this record on.
      const record = this.find(snapshot.mutationId)
      if (!record) continue
      if (record.state === 'applied' || record.state === 'cancelled') continue
      if (record.state !== 'queued') {
        // `accepted` awaits its apply; `dead-letter` waits for recovery or
        // cancel (D12: it blocks its OWN partition, and only that). Either way
        // nothing behind it in this partition may overtake it.
        return
      }
      if (this.isAgedOut(record)) {
        await this.expire(record)
        // The aged entry is parked; D10 forbids wedging, and the entries behind
        // it in this partition are not implicated by its age. But the parked
        // record now blocks the partition per D12, so stop here — the next pass
        // continues once the user recovers or discards it.
        return
      }
      if (!this.isDue(record)) {
        // D10 backoff: this entry's next attempt is not due yet. The whole
        // partition waits, because letting a successor overtake a backing-off
        // head would silently reorder writes to one aggregate (D12 FIFO) — and
        // OTHER partitions are untouched, which is the property that makes this a
        // delay rather than head-of-line blocking. The age check above runs
        // FIRST, so an entry whose backoff would outlive the horizon expires
        // instead of sleeping through it.
        return
      }
      try {
        if (!(await this.attempt(record))) return
      } catch (error) {
        // Another writer moved this entry (a discard from a second tab, say) while
        // we were staging the send. The user's decision wins, this partition stops,
        // and the next pass re-reads. Crucially the entry was never submitted:
        // `sending` must be durable BEFORE the envelope goes out.
        if (error instanceof OutboxStaleError) return
        throw error
      }
    }
  }

  /** @returns true when the partition may continue with the next entry. */
  private async attempt(queued: OutboxRecord): Promise<boolean> {
    const sending = await this.transition(queued, 'drain-started', {
      attempts: queued.attempts + 1,
      lastAttemptAt: this.config.now(),
      // The schedule has been consumed. Left in place it would be a stale
      // timestamp on an in-flight record, and the next transient failure sets a
      // fresh one anyway.
      nextAttemptAt: undefined,
    })

    let outcome: OutboxSubmitOutcome
    try {
      outcome = await this.config.submit.submit(envelopeFor(sending))
    } catch {
      // A throw is treated as transport failure — the conservative direction: a
      // misclassified blip costs a retry, a misclassified refusal would retry
      // poison forever (see OutboxSubmitOutcome).
      outcome = { kind: 'unreachable' }
    }

    if (outcome.kind === 'applied') {
      await this.transition(sending, 'authority-applied', { appliedAt: this.config.now() })
      return true
    }
    if (outcome.kind === 'accepted') {
      await this.transition(sending, 'authority-accepted', { acceptedAt: this.config.now() })
      // Order within the partition holds: nothing may be submitted behind an
      // envelope the Authority has taken but not yet applied.
      return false
    }
    // D10's retry classification, and the reason it is a shared function rather
    // than a second `case` arm: an authorization denial must be TERMINAL here
    // (D8 resolves the delegation chain live, so a post-revocation denial is
    // permanent), and "which failures are retryable" is the one judgement a
    // future edit could get wrong in a way no other test would notice.
    if (isDefinitiveFailure(outcome)) {
      // Zero automatic retries. Straight to rejection and dead-letter, so the
      // entry stops holding the head of its partition and stops burning the age
      // limit on an attempt that can never succeed.
      await this.reject(sending, normalizeRefusal(outcome.refusal))
      return false
    }
    // Transport failure — D9 invariant 4: this is NOT a rejection. Back to
    // `queued`, for unlimited attempts, until the age limit converts it to
    // `expired`. The exhaustiveness of the classification is checked by this
    // assignment: a new outcome kind that `failureClassOf` calls transient stops
    // compiling here until it is decided deliberately.
    const transient: 'unreachable' = outcome.kind
    void transient
    //
    // Returning FALSE is load-bearing, not incidental: the head of this
    // partition did not get through, so nothing behind it may be submitted.
    // Returning true here would silently reorder writes to one aggregate.
    await this.transition(sending, 'transport-failed', this.backoffPatch(sending.attempts))
    return false
  }

  /**
   * D10's exponential backoff, computed from the attempt count that just failed.
   * No attempt ceiling — the age limit is the only bound.
   *
   * Set HERE and nowhere else, and that placement is a decision. The other three
   * paths that requeue an entry (`noteTransportLost`, `requeueStalled`, the
   * open-time crash reconciliation) are not failed round-trips: a transport-loss
   * report is normally followed by an explicit reconnect, at which point we KNOW
   * the Authority is reachable and sleeping 60s would be user-visible latency for
   * no protection; a stall sweep has already waited its own `stalledForMs`, which
   * IS the spacing; and a cold open has no evidence about the Authority at all.
   * Backoff exists to stop a client hammering an Authority that just refused to
   * answer, so it is driven by the attempt that actually got no answer.
   */
  private backoffPatch(attempts: number): Partial<OutboxRecord> {
    return { nextAttemptAt: this.config.now() + backoffDelayMs(attempts, this.backoff) }
  }

  /** Has this entry's backoff elapsed? An entry that never failed has no
   *  schedule and is due immediately. */
  private isDue(record: OutboxRecord): boolean {
    return record.nextAttemptAt === undefined || this.config.now() >= record.nextAttemptAt
  }

  /**
   * The Authority applied an envelope it had merely `accepted` earlier. Separate
   * from the submit reply because accept and apply are two events whenever the
   * hop is not atomic, and D9 models them as two states.
   */
  async noteApplied(mutationId: MutationId): Promise<void> {
    await this.transition(this.require(mutationId), 'authority-applied', {
      appliedAt: this.config.now(),
    })
  }

  /** The Authority refused an envelope it had `accepted` — including the case the
   *  amendment cares most about: apply-time re-authorization denying a replay
   *  whose delegator lost rights while the client was offline (D16.4). */
  async noteRejected(
    mutationId: MutationId,
    refusal: Parameters<typeof normalizeRefusal>[0],
  ): Promise<void> {
    await this.reject(this.require(mutationId), normalizeRefusal(refusal))
  }

  /**
   * The transport died while an envelope was in flight or accepted-but-not-yet-
   * applied: `sending` / `accepted` → `queued` (D9 invariant 4).
   *
   * This exists because the `accepted → queued` edge has to be reachable WHILE
   * THE PROCESS LIVES, not only through a cold reopen. An `accepted` entry whose
   * apply notification is lost blocks its partition, and "wait for a restart" is
   * not a recovery path — it is invariant 1's "gone" hazard wearing the opposite
   * coat, work the user can neither see resolved nor recover. Replaying is safe
   * because the `mutationId` is unchanged (D11.7).
   */
  async noteTransportLost(mutationId: MutationId): Promise<OutboxRecord> {
    const record = this.require(mutationId)
    if (record.state !== 'sending' && record.state !== 'accepted') {
      throw new OutboxUsageError(
        `cannot requeue ${mutationId} from ${record.state}: nothing is in flight`,
      )
    }
    return await this.transition(record, 'transport-failed', {})
  }

  /**
   * Sweep every entry that has been `sending` or `accepted` with no progress for
   * longer than `stalledForMs`, back to `queued`. The liveness backstop for a
   * reply that never came; the CADENCE that calls it is POD-371's.
   */
  async requeueStalled(opts: { readonly stalledForMs: number }): Promise<readonly MutationId[]> {
    const now = this.config.now()
    const stalled = this.mine().filter(
      (r) =>
        (r.state === 'sending' || r.state === 'accepted') &&
        now - (r.lastAttemptAt ?? r.queuedAt) >= opts.stalledForMs,
    )
    for (const record of stalled) await this.transition(record, 'transport-failed', {})
    return stalled.map((r) => r.mutationId)
  }

  /**
   * Retire an `applied` entry after covering truth landed. This is D9 invariant
   * 1's second (and only non-user) licence to make an entry gone; today's
   * `awaiting-truth` is the sub-stage of `applied` that ends here, not a ninth
   * state.
   *
   * Pass the `span` of a `SyncUnitOfWork` transaction (ADR 2 D10) to enroll the
   * write in it, so the entity rows, the cursor advance and this retirement land
   * together or not at all. Enrollment is EXPLICIT because an ambient transaction
   * cannot portably reach an inner store call (POD-369's amendment 1); the
   * parameter is optional, so callers that do not use the seam are unaffected.
   */
  async retireApplied(mutationId: MutationId, span?: SyncSpan): Promise<void> {
    await this.retireAllApplied([mutationId], span)
  }

  /**
   * Retire SEVERAL applied entries as ONE batch: one enrolled write, one
   * publication (D9 invariant 1's covering-truth licence, applied N times).
   *
   * This is the shape the Replica needs and the reason it exists: one certified
   * frame can carry several provenance matches, and a bootstrap install
   * aggregates matches across every buffered frame it includes. POD-369 collects
   * and deduplicates them, then submits one ordered batch in the same span as the
   * entity operations and the cursor advance — so this must produce exactly one
   * outbox write, not N of them.
   *
   * Order is the caller's: the batch is applied in the order given. Ids are
   * deduplicated defensively, and the whole batch is validated BEFORE anything is
   * staged, so a bad id fails the batch rather than half-retiring it.
   */
  async retireAllApplied(ids: readonly MutationId[], span?: SyncSpan): Promise<void> {
    const unique: MutationId[] = []
    for (const id of ids) if (!unique.includes(id)) unique.push(id)
    if (unique.length === 0) return
    await this.mutate((draft) => {
      for (const id of unique) {
        const record = draft.find(id)
        if (!record || !belongsTo(record, this.principal)) {
          throw new OutboxUsageError(`unknown outbox entry: ${id}`)
        }
        if (record.state !== 'applied') {
          throw new OutboxUsageError(
            `cannot retire ${id} from ${record.state}: only an applied entry retires after covering truth`,
          )
        }
      }
      for (const id of unique) {
        draft.remove(id, 'covering-truth')
        draft.emit({ type: 'retired', mutationId: id })
      }
    }, span)
  }

  /** Age out everything past `maxAgeMs`, whether or not a drain is running
   *  (D10: `queued`/`sending` → `expired` → `dead-letter`, reason `max-age`). */
  async sweepExpired(): Promise<readonly MutationId[]> {
    const doomed = this.mine().filter(
      (r) => (r.state === 'queued' || r.state === 'sending') && this.isAgedOut(r),
    )
    for (const record of doomed) await this.expire(record)
    return doomed.map((r) => r.mutationId)
  }

  /**
   * D9 invariant 3 — **retry**: put the SAME input back in flight, once its
   * precondition is satisfied. The precondition comes from the reason code
   * (`recoveryPlanFor`), and a mismatch is refused: an authorization denial
   * cannot be waved through with a rebase, which is precisely the distinction
   * D16.4 requires the record to preserve.
   */
  async retry(mutationId: MutationId, satisfaction: RetrySatisfaction): Promise<OutboxRecord> {
    const record = this.require(mutationId)
    if (record.state !== 'dead-letter') {
      throw new OutboxUsageError(`cannot retry ${mutationId} from ${record.state}`)
    }
    const reason = record.reason
    if (!reason) throw new OutboxUsageError(`dead-lettered ${mutationId} carries no reason`)
    const plan = recoveryPlanFor(reason.code)
    if (!satisfies(plan.retry, satisfaction)) {
      throw new OutboxUsageError(
        `retry of ${mutationId} requires ${plan.retry}; nothing in the supplied satisfaction meets it`,
      )
    }
    if ('mutationId' in satisfaction) {
      // D11.4: an `expired` entry's id may still have a receipt, so a re-issue
      // MUST mint a new one. The old record leaves the recovery surface by the
      // user's own action (invariant 1), and its work continues under the new id.
      return await this.reissue(record, satisfaction.mutationId as MutationId, {
        input: record.input,
        ...revisionOf(record),
      })
    }
    const patch: Partial<OutboxRecord> = {
      ...revisionOfValue(
        'expectedRevision' in satisfaction ? satisfaction.expectedRevision : undefined,
      ),
      ...('confirmed' in satisfaction ? CONFIRMED : {}),
    }
    return await this.transition(record, 'user-retried', {
      ...patch,
      reason: undefined,
      deadLetteredAt: undefined,
      parkedFrom: undefined,
      // A user retry is immediate: the backoff schedule belonged to the transport
      // failures that preceded the parking, and a person who has just fixed their
      // rights should not wait out a machine's spacing.
      nextAttemptAt: undefined,
    })
  }

  /**
   * D9 invariant 3 — **edit**: revise the input, which is a NEW attempt. It
   * always mints a new `mutationId`: an id names an intent, and replaying a
   * changed input under the old id could collide with a stored receipt for the
   * original one (D11.7) — the user would get the old result for text they have
   * since rewritten.
   */
  async edit(mutationId: MutationId, request: EditRequest): Promise<OutboxRecord> {
    const record = this.require(mutationId)
    if (record.state !== 'dead-letter') {
      throw new OutboxUsageError(`cannot edit ${mutationId} from ${record.state}`)
    }
    return await this.reissue(record, this.config.newMutationId(), request)
  }

  /** D9 invariant 3 — **discard** → `cancelled`. Also legal straight from
   *  `queued`: invariant 1 licenses "gone" on user action, and cancelling a
   *  write you can still see pending is the plainest form of that. */
  async discard(mutationId: MutationId): Promise<OutboxRecord> {
    return await this.transition(this.require(mutationId), 'user-discarded', {
      cancelledAt: this.config.now(),
    })
  }

  /** Drop a `cancelled` record from the store. Separate from `discard` so that
   *  the user's decision is durable first and the row's removal is a second,
   *  explicit step. */
  async purgeCancelled(mutationId: MutationId): Promise<void> {
    const record = this.require(mutationId)
    if (record.state !== 'cancelled') {
      throw new OutboxUsageError(`cannot purge ${mutationId} from ${record.state}`)
    }
    await this.mutate((draft) => {
      draft.remove(mutationId, 'user-discarded')
    })
  }

  // ADR 2 D7 — "discard the cache, re-bootstrap, KEEP THE OUTBOX" — is upheld
  // here by ABSENCE: no method on this class takes a re-bootstrap, a rung, an
  // epoch or a rescope as its subject, and no code path can remove a record
  // without one of D9 invariant 1's two licences (see OutboxDraft). See the note
  // in ports.ts for why absence beats a contractual no-op.

  // ---- internals ----------------------------------------------------------

  /**
   * No principal-bound instance may write another principal's keys — agreed with
   * POD-369 for the shared-span case, and a stronger statement than "does not
   * today": the delta is checked against ownership before it can be enrolled, so
   * two instances staging into one span can only ever touch disjoint keys.
   */
  private assertOwnKeysOnly(delta: OutboxStoreMutation, base: readonly OutboxRecord[]): void {
    const foreign: MutationId[] = []
    for (const record of delta.put ?? []) {
      if (!belongsTo(record, this.principal)) foreign.push(record.mutationId)
    }
    for (const id of delta.remove ?? []) {
      const existing = base.find((r) => r.mutationId === id)
      if (existing && !belongsTo(existing, this.principal)) foreign.push(id)
    }
    if (foreign.length > 0) {
      throw new OutboxInvariantError(
        `outbox bound to ${this.principal} tried to write keys owned by another principal: ${foreign.join(', ')}`,
      )
    }
  }

  /** This principal's slice of the store. */
  private mine(): readonly OutboxRecord[] {
    return this.records.filter((r) => belongsTo(r, this.principal))
  }

  private async reconcileOnOpen(): Promise<void> {
    for (const record of this.mine()) {
      if (record.state === 'sending' || record.state === 'accepted') {
        await this.transition(record, 'transport-failed', {})
      }
    }
    // The LONG-OFFLINE client (D11.5): a client that returns after longer than
    // the age limit must find its aged work already resolved into dead-letter
    // recovery, not sitting in `queued` waiting for something to notice.
    //
    // The drain would refuse to send an aged entry anyway, but only the HEAD of
    // each partition and only when a drain runs. Sweeping at open makes the state
    // honest before anyone reads it: every entry past the horizon is `dead-letter`
    // with reason `max-age`, its recovery is `new-mutation-id` (D11.4 — the old id
    // may still carry a receipt), and the user's authored input is intact and
    // surfaced. Nothing is dropped; expiry is how we REFUSE the send, not how we
    // discard the intent.
    await this.sweepExpired()
    // Invariant 2 straggler: a crash between the verdict and the parking must
    // not leave an entry resolved but unrecoverable.
    for (const record of this.mine()) {
      if (record.state === 'rejected' || record.state === 'expired') await this.park(record)
    }
  }

  /** D10 measures from `queuedAt` — the moment the USER authored the intent —
   *  and never from `lastAttemptAt`. Measuring from the last attempt would let a
   *  busy entry renew its own horizon on every retry and never expire, which
   *  defeats D11's inequality: the whole point of expiry is to refuse a send
   *  whose receipt may already have been pruned. `queuedAt` is immutable. */
  private isAgedOut(record: OutboxRecord): boolean {
    return this.config.now() - record.queuedAt > this.maxAgeFor(record)
  }

  /** The horizon for ONE entry: the configured base, or the per-command override
   *  when the contract asked for a shorter one (D10). */
  private maxAgeFor(record: OutboxRecord): number {
    return resolveMaxAgeMs(
      this.config.maxAgeMs,
      record.command.name,
      this.config.commandMaxAgeMs?.[record.command.name],
    )
  }

  private async expire(record: OutboxRecord): Promise<void> {
    const expired = await this.transition(record, 'aged-out', { reason: MAX_AGE_REASON })
    await this.park(expired)
  }

  private async reject(record: OutboxRecord, reason: OutboxRejectionReason): Promise<void> {
    const rejected = await this.transition(record, 'authority-rejected', { reason })
    await this.park(rejected)
  }

  /** D9 invariant 2: `rejected` / `expired` ALWAYS enter dead-letter, with a
   *  reason code the UI can render. There is no branch here that skips it. */
  private async park(record: OutboxRecord): Promise<void> {
    await this.transition(record, 'parked', {
      deadLetteredAt: this.config.now(),
      parkedFrom: record.state === 'expired' ? 'expired' : 'rejected',
    })
  }

  private async reissue(
    old: OutboxRecord,
    mutationId: MutationId,
    request: EditRequest,
  ): Promise<OutboxRecord> {
    // D11.4 is a MUST: a re-issue may not reuse the retired id, because a
    // receipt for it may still exist and the replay would return that stored
    // result instead of running the new intent.
    if (mutationId === old.mutationId) {
      throw new OutboxUsageError(
        `re-issue of ${old.mutationId} must mint a NEW mutationId (D11.4): a receipt for the old id may still exist`,
      )
    }
    return await this.mutate((draft) => {
      // Global uniqueness, across every principal in the store: the id is the
      // Authority's dedupe key.
      if (draft.find(mutationId)) {
        throw new OutboxUsageError(
          `cannot re-issue as ${mutationId}: that mutationId already exists`,
        )
      }
      const fresh: OutboxRecord = {
        mutationId,
        command: old.command,
        input: request.input,
        ...revisionOf(request),
        partitionKey: old.partitionKey,
        ...collapseKeyOf(old),
        attribution: old.attribution,
        state: 'queued',
        queuedAt: this.config.now(),
        attempts: 0,
      }
      // The predecessor is cancelled and then REMOVED, in this one transaction.
      //
      // POD-785: it used to be written back as a `cancelled` row and left there
      // for ever. Nothing removed it — `purgeCancelled` has a single caller, the
      // user's discard button — so every retry-with-new-id and every edit leaked
      // one permanent row carrying the whole original input. Measured at 25 edits
      // of one failing write: 25 tombstones, 11.4 KB, none of it reachable.
      //
      // Removing it loses nothing recoverable. The user's intent continues under
      // `fresh`, which is staged in the same transaction; `cancelled` is a
      // terminal state with no transition out of it, and no surface reads it
      // (`pending`, `deadLetters` and the drain all exclude it). The transition is
      // still computed through the state table, so an illegal `old.state` throws
      // exactly as before rather than being skipped by the removal.
      const cancelled: OutboxRecord = {
        ...old,
        state: applyOutboxTransition(old.state, 'user-discarded'),
        cancelledAt: this.config.now(),
      }
      draft.put(cancelled)
      draft.remove(cancelled.mutationId, 'user-discarded')
      draft.put(fresh)
      draft.emit({ type: 'cancelled', mutationId: old.mutationId })
      draft.emit({ type: 'local-ack', mutationId })
      return fresh
    })
  }

  /** Resolve one of THIS PRINCIPAL's records. A foreign id reads as unknown —
   *  the same answer as a nonexistent one, so the bound view is not an existence
   *  oracle for another user's queue either. */
  private require(mutationId: MutationId): OutboxRecord {
    const record = this.find(mutationId)
    if (!record) throw new OutboxUsageError(`unknown outbox entry: ${mutationId}`)
    return record
  }

  /**
   * One state change: through the pure table (an illegal cell throws rather than
   * coercing), staged, persisted, adopted, and only then observed.
   */
  private async transition(
    subject: OutboxRecord,
    transition: OutboxTransition,
    patch: Partial<OutboxRecord> & { reason?: OutboxRejectionReason | undefined },
  ): Promise<OutboxRecord> {
    return await this.mutate((draft) => {
      // Read the record from the REBASED draft, not from the caller's snapshot:
      // the mutation rebases on fresh truth, so another writer (or an earlier
      // step in the same span) may have moved it on.
      const record = draft.find(subject.mutationId)
      if (!record) {
        throw new OutboxStaleError(`outbox entry vanished before transition: ${subject.mutationId}`)
      }
      if (
        record.state !== subject.state &&
        nextOutboxState(record.state, transition) === undefined
      ) {
        // Another writer moved it somewhere this transition cannot leave from.
        // A lost race, not a bug: the caller re-reads and decides again.
        throw new OutboxStaleError(
          `outbox entry ${subject.mutationId} moved to ${record.state} before ${transition}`,
        )
      }
      const next: OutboxRecord = {
        ...record,
        ...patch,
        state: applyOutboxTransition(record.state, transition),
      }
      // `undefined` in a patch means "clear it" — spread leaves the key present
      // with an undefined value, which would serialise into the durable record.
      const cleaned = Object.fromEntries(
        Object.entries(next).filter(([, v]) => v !== undefined),
      ) as unknown as OutboxRecord
      draft.put(cleaned)
      for (const event of eventsForTransition(cleaned, transition)) draft.emit(event)
      return cleaned
    })
  }

  /**
   * The ONLY writer. Serializes, stages, commits, adopts, then emits.
   *
   * The order is the whole point: the in-memory record set is replaced only after
   * the store write RESOLVES, so a quota denial or a closed database leaves
   * memory untouched (ADR 6 D4.4: the failing operation does not partially
   * apply), and events — which are observability — never precede durability
   * (D4.3). Serializing means two concurrent callers cannot stage from the same
   * base and commit out of order.
   */
  private async mutate<T>(body: (draft: OutboxDraft) => T, ambient?: SyncSpan): Promise<T> {
    const run = this.mutations.then(async () => {
      // A conflict means another instance or tab committed first. Re-stage against
      // fresh truth and let the body decide again — it may now legitimately fail (a
      // duplicate id, an illegal transition), which is exactly the point: the loser
      // of the race must not overwrite the winner. Nothing is adopted and no event
      // escapes until an attempt actually lands.
      for (let attempt = 1; ; attempt++) {
        try {
          // An AMBIENT span belongs to the caller: a conflict inside it kills their
          // transaction, and retrying our part alone would be meaningless, so it
          // propagates for them to decide.
          if (ambient) return await this.stage(body, ambient)
          // No span means nothing to be atomic WITH: this mutation touches one store,
          // and `store.apply` is already one atomic, precondition-checked operation.
          // Opening a unit-of-work transaction here would be worse than pointless —
          // it is what let an unrelated caller's open transaction absorb this
          // mutation, so that it reported success before durability and vanished when
          // that transaction aborted. The seam is for JOINING a multi-participant
          // commit, and that always arrives as an explicit span (SyncUnitOfWork's
          // no-per-write-fallback rule is about splitting one logical commit across
          // transactions, not about wrapping a single atomic write).
          return await this.stage(body, undefined)
        } catch (error) {
          // Only an APPLY-time conflict is ours to resolve, by re-staging against
          // fresh truth. A COMMIT-time conflict can only arise inside a span the
          // CALLER owns, and it arrives as `SyncCommitConflict` on their `transact`
          // call, not here — their transaction is what rolled back, so the retry
          // decision is theirs. Hence no arm for it: an unreachable branch claiming
          // to handle a case is worse than its absence.
          if (!(error instanceof OutboxConflict) || attempt >= MUTATION_CONFLICT_ATTEMPTS) {
            throw error
          }
        }
      }
    })
    // The chain must survive a rejection, or one failed write would wedge every
    // later mutation.
    this.mutations = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  /**
   * Stage one mutation and enroll its delta.
   *
   * Two rebasing rules, each fixing a data-loss bug that a per-instance snapshot
   * caused:
   *
   * - **Outside a span, rebase on FRESH TRUTH from the store.** This instance is
   *   not the only writer: the privacy model explicitly supports a second
   *   principal-bound instance over the same physical store, and ADR 6 D4.6 adds
   *   a second browser tab. Staging from a stale in-memory base and writing a
   *   whole snapshot silently deleted the other writer's queued work. It is also
   *   what makes `mutationId` uniqueness global rather than per-instance.
   * - **Inside a span, rebase on fresh truth PLUS the span's own accumulated
   *   deltas.** Enrolled writes have not landed yet, so a plain re-read would return
   *   the pre-span state and the second retirement in one span would resurrect the
   *   first. One span therefore accumulates record-level deltas and publishes ONCE,
   *   on commit — a feed frame can carry several provenance retirements.
   *
   * Adoption at commit is a record-level MERGE onto the LATEST memory, never a
   * replacement with the span's snapshot. That distinction is a bug I shipped:
   * replacing memory with a snapshot taken when the span opened erased any
   * independent user action that had committed while it was open, so an
   * acknowledged, durable enqueue vanished from `pending()` and never drained until
   * something else rebased. Deltas merge; snapshots overwrite.
   */
  private async stage<T>(body: (draft: OutboxDraft) => T, span?: SyncSpan): Promise<T> {
    const staged = span ? this.spanDeltas.get(span) : undefined
    const truth = await this.store.read()
    const base = staged ? staged.reduce(applyMutation, [...truth]) : truth
    const draft = new OutboxDraft(base)
    const result = body(draft)
    const next = draft.sealed()
    const delta = draft.delta()
    this.assertOwnKeysOnly(delta, base)
    if (!span) {
      const outcome = await this.store.apply(delta)
      if (!outcome.ok) throw new OutboxConflict(outcome.conflicts)
      this.records = next
      for (const event of draft.events) this.emit(event)
      return result
    }
    const accumulated = this.spanDeltas.get(span)
    if (accumulated) accumulated.push(delta)
    else this.spanDeltas.set(span, [delta])
    const pending = this.spanEvents.get(span)
    if (pending) pending.push(...draft.events)
    else {
      this.spanEvents.set(span, [...draft.events])
      // ONE publication per span, registered once: in-memory adoption and event
      // emission happen from `onCommit` so nothing escapes to a subscriber before
      // the outer transaction is durable (POD-369's amendment 2).
      span.onCommit(() => {
        // MERGE the span's deltas onto current memory, which by now may already
        // include an independent user action that committed while the span was open.
        const deltas = this.spanDeltas.get(span) ?? []
        this.records = deltas.reduce(applyMutation, [...this.records])
        for (const event of this.spanEvents.get(span) ?? []) this.emit(event)
        this.spanDeltas.delete(span)
        this.spanEvents.delete(span)
      })
      // No abort hook, and none needed: nothing is adopted and nothing is emitted
      // until `onCommit` runs, so an aborted span leaves this instance exactly as
      // it was. The staged deltas are keyed by the span object in a WeakMap, so an
      // abandoned span's staging is collected rather than lingering — there is no
      // cleanup a forgotten callback could skip.
    }
    const outcome = await this.store.apply(delta, span)
    // Inside a span an adapter may only be able to answer at commit time, in which
    // case it aborts the span instead of returning a conflict here.
    if (!outcome.ok) throw new OutboxConflict(outcome.conflicts)
    return result
  }

  private emit(event: OutboxEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/**
 * Apply one record-level mutation to a record list, preserving insertion order: a
 * first `put` appends, a replacing `put` keeps its position, `remove` deletes by id,
 * and anything unmentioned is untouched. The in-memory twin of what the STORE does,
 * used to rebase a span's view and to MERGE its deltas into memory at commit.
 *
 * "Twin" is a claim, and a comment asserting an invariant is evidence that somebody
 * worried about it — not that it holds. So it is EXPORTED and a test asserts the two
 * implementations agree over whole results for a table of mutations, rather than
 * trusting the two bodies to be kept in step. Two mappers for one hop with a comment
 * saying they agree is the drift this programme is deleting.
 */
export const applyMutation = (
  records: OutboxRecord[],
  mutation: OutboxStoreMutation,
): OutboxRecord[] => {
  const next = [...records]
  for (const id of mutation.remove ?? []) {
    const idx = next.findIndex((r) => r.mutationId === id)
    if (idx !== -1) next.splice(idx, 1)
  }
  for (const record of mutation.put ?? []) {
    const idx = next.findIndex((r) => r.mutationId === record.mutationId)
    if (idx === -1) next.push(record)
    else next[idx] = record
  }
  return next
}

/** The observable consequence of each transition. Kept beside the table rather
 *  than at each call site so a new edge cannot land silently unobservable. */
const eventsForTransition = (
  record: OutboxRecord,
  transition: OutboxTransition,
): readonly OutboxEvent[] => {
  const mutationId = record.mutationId
  switch (transition) {
    case 'drain-started':
      return [{ type: 'sending', mutationId }]
    case 'authority-accepted':
      return [{ type: 'accepted', mutationId }]
    case 'authority-applied':
      return [{ type: 'applied', mutationId }]
    case 'transport-failed':
    case 'user-retried':
      return [{ type: 'requeued', mutationId }]
    case 'authority-rejected':
      return record.reason ? [{ type: 'rejected', mutationId, reason: record.reason }] : []
    case 'aged-out':
      return record.reason ? [{ type: 'expired', mutationId, reason: record.reason }] : []
    case 'parked':
      return [{ type: 'dead-lettered', record: toDeadLetterRecord(record) }]
    case 'user-discarded':
      return [{ type: 'cancelled', mutationId }]
  }
}

/**
 * The wire shape for one attempt. Note what is NOT copied across: the
 * attribution. The principal is the transport's (D7); anything identity-shaped
 * here would be payload identity, which is inert by decision and an
 * impersonation primitive in practice (amendment D14.3).
 */
export const envelopeFor = (record: OutboxRecord): OutboxEnvelope => ({
  mutationId: record.mutationId,
  command: record.command.name,
  version: record.command.version,
  input: record.input,
  ...revisionOf(record),
  ...confirmationOf(record),
})

/** Project a parked record into the record POD-316 recovers from. Everything in
 *  it is the author's own input or a code — never target content, which is what
 *  lets an entry be recovered against an entity its author can no longer see. */
export const toDeadLetterRecord = (record: OutboxRecord): DeadLetterRecord => {
  const reason = record.reason
  const parkedFrom = record.parkedFrom
  if (!reason || !parkedFrom) {
    throw new OutboxUsageError(`record ${record.mutationId} is not parked`)
  }
  return {
    mutationId: record.mutationId,
    command: record.command,
    input: record.input,
    ...revisionOf(record),
    attribution: record.attribution,
    queuedAt: record.queuedAt,
    deadLetteredAt: record.deadLetteredAt ?? record.queuedAt,
    parkedFrom,
    reason,
    recovery: recoveryPlanFor(reason.code),
    attempts: record.attempts,
  }
}

export const openOutbox = (config: OutboxConfig): Promise<Outbox> => Outbox.open(config)
