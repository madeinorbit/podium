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
 * import-the-constant lint are D10/D11 numbers owned by POD-371; this module
 * takes `maxAgeMs` as configuration and never mints a default.
 *
 * ## Ordering
 *
 * FIFO **within** an ordering partition, concurrent **across** partitions
 * (D12). Global head-of-line blocking is forbidden; a blocked or dead-lettered
 * entry blocks only its own partition, until recovery or cancel.
 *
 * ## What this module deliberately cannot do
 *
 * - It cannot hold a secret: `enqueue` accepts only `offline-eligible` commands,
 *   and D4 rule 1 makes `secret` policy imply `online-sensitive` (POD-352).
 * - It cannot hold a capability, an "allow" bit or any rights snapshot, so a
 *   replay cannot re-present stale rights. Re-authorization is the Authority's,
 *   live over the delegation chain, at every apply (D8 / amendment D16).
 * - It cannot drop user-authored work. Every path out of the store is either a
 *   user action or an `applied` retirement after covering truth (D9 invariant 1),
 *   with exactly one exception: a genuinely unreadable store, which is loud
 *   (ADR 2 D7).
 */

import type { MutationId } from '@podium/protocol'
import type {
  DeadLetterQuery,
  OutboxConfig,
  OutboxEnvelope,
  OutboxEvent,
  OutboxStorePort,
  OutboxSubmitOutcome,
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
  confirmationOf,
  type DeadLetterRecord,
  ENQUEUEABLE_DELIVERY,
  type EnvelopeConfirmation,
  type OutboxAttribution,
  type OutboxCommand,
  type OutboxRecord,
} from './records'
import { applyOutboxTransition } from './states'

export interface EnqueueRequest extends EnvelopeConfirmation {
  readonly command: OutboxCommand
  readonly input: unknown
  /**
   * The principal the entry is authored under, taken from the AUTHENTICATED
   * TRANSPORT by the caller (ADR 3 D7 / amendment D14, D17). It is a separate
   * argument from `input` on purpose: identity that arrives inside a payload is
   * inert by decision, and the Outbox has no code path that reads one.
   */
  readonly attribution: OutboxAttribution
  readonly expectedRevision?: number
  /** ADR 3 D12. Defaults to a private `create:<mutationId>` partition, which is
   *  D12's own rule for additive commands with no existing target id — so an
   *  unpartitioned entry can never block another aggregate. */
  readonly partitionKey?: string
  /** Supply one to keep a caller-minted id; otherwise the config mints it. */
  readonly mutationId?: MutationId
}

export interface EditRequest {
  readonly input: unknown
  readonly expectedRevision?: number
}

/** Thrown for a caller mistake: an illegal recovery, an unknown id, a delivery
 *  class the Outbox may not hold. Distinct from an Authority refusal, which is
 *  never an exception — it is a state. */
export class OutboxUsageError extends Error {}

export class Outbox {
  private readonly config: OutboxConfig
  private readonly store: OutboxStorePort
  /** Insertion order IS the FIFO order within a partition. */
  private records: OutboxRecord[]
  private readonly listeners = new Set<(event: OutboxEvent) => void>()
  private draining: Promise<void> | null = null

  private constructor(config: OutboxConfig, records: OutboxRecord[]) {
    this.config = config
    this.store = config.store
    this.records = records
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

  /** Every record, in FIFO order. Diagnostics, the drain and conformance probes —
   *  NOT a UI surface: the recovery UI reads `deadLetters`, which is scoped to a
   *  principal (readiness §3.1.1, brief point 4). */
  all(): readonly OutboxRecord[] {
    return [...this.records]
  }

  find(mutationId: MutationId): OutboxRecord | undefined {
    return this.records.find((r) => r.mutationId === mutationId)
  }

  /** The optimistic-overlay input (POD-372): entries the user has authored that
   *  the Authority has not applied yet. */
  pending(): readonly OutboxRecord[] {
    return this.records.filter(
      (r) => r.state === 'queued' || r.state === 'sending' || r.state === 'accepted',
    )
  }

  /**
   * The recovery surface, scoped to ONE principal. There is deliberately no
   * unscoped accessor: a dead-letter entry is personal state belonging to the
   * human it was authored on behalf of, and it must never surface in another
   * user's recovery UI (private-by-default, readiness §3.1.1).
   */
  deadLetters(query: DeadLetterQuery): readonly DeadLetterRecord[] {
    return this.records
      .filter((r) => r.state === 'dead-letter' && belongsTo(r, query.forUser))
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
    const mutationId = request.mutationId ?? this.config.newMutationId()
    if (this.find(mutationId)) {
      throw new OutboxUsageError(`duplicate mutationId in outbox: ${mutationId}`)
    }
    const record: OutboxRecord = {
      mutationId,
      command: request.command,
      input: request.input,
      ...(request.expectedRevision === undefined
        ? {}
        : { expectedRevision: request.expectedRevision }),
      partitionKey: request.partitionKey ?? `create:${mutationId}`,
      attribution: request.attribution,
      state: 'queued',
      queuedAt: this.config.now(),
      attempts: 0,
      ...confirmationOf(request),
    }
    this.records.push(record)
    await this.persist()
    this.emit({ type: 'local-ack', mutationId })
    return record
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
    for (const record of this.records) {
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
      if (!(await this.attempt(record))) return
    }
  }

  /** @returns true when the partition may continue with the next entry. */
  private async attempt(queued: OutboxRecord): Promise<boolean> {
    const sending = await this.transition(queued, 'drain-started', {
      attempts: queued.attempts + 1,
      lastAttemptAt: this.config.now(),
    })
    this.emit({ type: 'sending', mutationId: sending.mutationId })

    let outcome: OutboxSubmitOutcome
    try {
      outcome = await this.config.submit.submit(envelopeFor(sending))
    } catch {
      // A throw is treated as transport failure — the conservative direction: a
      // misclassified blip costs a retry, a misclassified refusal would retry
      // poison forever (see OutboxSubmitOutcome).
      outcome = { kind: 'unreachable' }
    }

    switch (outcome.kind) {
      case 'applied': {
        const applied = await this.transition(sending, 'authority-applied', {
          appliedAt: this.config.now(),
        })
        this.emit({ type: 'applied', mutationId: applied.mutationId })
        return true
      }
      case 'accepted': {
        const accepted = await this.transition(sending, 'authority-accepted', {
          acceptedAt: this.config.now(),
        })
        this.emit({ type: 'accepted', mutationId: accepted.mutationId })
        // Order within the partition holds: nothing may be submitted behind an
        // envelope the Authority has taken but not yet applied.
        return false
      }
      case 'rejected': {
        await this.reject(sending, normalizeRefusal(outcome.refusal))
        return false
      }
      case 'unreachable': {
        // D9 invariant 4: this is NOT a rejection. Back to `queued`, forever if
        // need be, until the age limit converts it to `expired`.
        const requeued = await this.transition(sending, 'transport-failed', {})
        this.emit({ type: 'requeued', mutationId: requeued.mutationId })
        return false
      }
    }
  }

  /**
   * The Authority applied an envelope it had merely `accepted` earlier. Separate
   * from the submit reply because accept and apply are two events whenever the
   * hop is not atomic, and D9 models them as two states.
   */
  async noteApplied(mutationId: MutationId): Promise<void> {
    const record = this.require(mutationId)
    const applied = await this.transition(record, 'authority-applied', {
      appliedAt: this.config.now(),
    })
    this.emit({ type: 'applied', mutationId: applied.mutationId })
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
   * Retire an `applied` entry after covering truth landed. This is D9 invariant
   * 1's second (and only non-user) licence to make an entry gone; today's
   * `awaiting-truth` is the sub-stage of `applied` that ends here, not a ninth
   * state.
   */
  async retireApplied(mutationId: MutationId): Promise<void> {
    const record = this.require(mutationId)
    if (record.state !== 'applied') {
      throw new OutboxUsageError(
        `cannot retire ${mutationId} from ${record.state}: only an applied entry retires after covering truth`,
      )
    }
    this.records = this.records.filter((r) => r.mutationId !== mutationId)
    await this.persist()
    this.emit({ type: 'retired', mutationId })
  }

  /** Age out everything past `maxAgeMs`, whether or not a drain is running
   *  (D10: `queued`/`sending` → `expired` → `dead-letter`, reason `max-age`). */
  async sweepExpired(): Promise<readonly MutationId[]> {
    const doomed = this.records.filter(
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
        ...(record.expectedRevision === undefined
          ? {}
          : { expectedRevision: record.expectedRevision }),
      })
    }
    const patch: Partial<OutboxRecord> = {
      ...('expectedRevision' in satisfaction
        ? { expectedRevision: satisfaction.expectedRevision }
        : {}),
      ...('confirmed' in satisfaction ? CONFIRMED : {}),
    }
    const requeued = await this.transition(record, 'user-retried', {
      ...patch,
      reason: undefined,
      deadLetteredAt: undefined,
      parkedFrom: undefined,
    })
    this.emit({ type: 'requeued', mutationId: requeued.mutationId })
    return requeued
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
    const record = this.require(mutationId)
    const cancelled = await this.transition(record, 'user-discarded', {
      cancelledAt: this.config.now(),
    })
    this.emit({ type: 'cancelled', mutationId })
    return cancelled
  }

  /** Drop a `cancelled` record from the store. Separate from `discard` so that
   *  the user's decision is durable first and the row's removal is a second,
   *  explicit step. */
  async purgeCancelled(mutationId: MutationId): Promise<void> {
    const record = this.require(mutationId)
    if (record.state !== 'cancelled') {
      throw new OutboxUsageError(`cannot purge ${mutationId} from ${record.state}`)
    }
    this.records = this.records.filter((r) => r.mutationId !== mutationId)
    await this.persist()
  }

  // ADR 2 D7 — "discard the cache, re-bootstrap, KEEP THE OUTBOX" — is upheld
  // here by ABSENCE: no method on this class takes a re-bootstrap, a rung, an
  // epoch or a rescope as its subject, and none clears the queue. See the note
  // in ports.ts for why that is stronger than a contractual no-op would be.

  // ---- internals ----------------------------------------------------------

  private async reconcileOnOpen(): Promise<void> {
    let changed = false
    for (const record of [...this.records]) {
      if (record.state === 'sending' || record.state === 'accepted') {
        this.replace({ ...record, state: applyOutboxTransition(record.state, 'transport-failed') })
        changed = true
      }
    }
    if (changed) await this.persist()
    // Invariant 2 straggler: a crash between the verdict and the parking must
    // not leave an entry resolved but unrecoverable.
    for (const record of [...this.records]) {
      if (record.state === 'rejected' || record.state === 'expired') await this.park(record)
    }
  }

  private isAgedOut(record: OutboxRecord): boolean {
    return this.config.now() - record.queuedAt > this.config.maxAgeMs
  }

  private async expire(record: OutboxRecord): Promise<void> {
    const expired = await this.transition(record, 'aged-out', { reason: MAX_AGE_REASON })
    this.emit({ type: 'expired', mutationId: expired.mutationId, reason: MAX_AGE_REASON })
    await this.park(expired)
  }

  private async reject(record: OutboxRecord, reason: OutboxRejectionReason): Promise<void> {
    const rejected = await this.transition(record, 'authority-rejected', { reason })
    this.emit({ type: 'rejected', mutationId: rejected.mutationId, reason })
    await this.park(rejected)
  }

  /** D9 invariant 2: `rejected` / `expired` ALWAYS enter dead-letter, with a
   *  reason code the UI can render. There is no branch here that skips it. */
  private async park(record: OutboxRecord): Promise<void> {
    const from = record.state === 'expired' ? 'expired' : 'rejected'
    const parked = await this.transition(record, 'parked', {
      deadLetteredAt: this.config.now(),
      parkedFrom: from,
    })
    this.emit({ type: 'dead-lettered', record: toDeadLetterRecord(parked) })
  }

  private async reissue(
    old: OutboxRecord,
    mutationId: MutationId,
    request: EditRequest,
  ): Promise<OutboxRecord> {
    const fresh: OutboxRecord = {
      mutationId,
      command: old.command,
      input: request.input,
      ...(request.expectedRevision === undefined
        ? {}
        : { expectedRevision: request.expectedRevision }),
      partitionKey: old.partitionKey,
      attribution: old.attribution,
      state: 'queued',
      queuedAt: this.config.now(),
      attempts: 0,
    }
    this.replace({
      ...old,
      state: applyOutboxTransition(old.state, 'user-discarded'),
      cancelledAt: this.config.now(),
    })
    this.records.push(fresh)
    await this.persist()
    this.emit({ type: 'cancelled', mutationId: old.mutationId })
    this.emit({ type: 'local-ack', mutationId })
    return fresh
  }

  private require(mutationId: MutationId): OutboxRecord {
    const record = this.find(mutationId)
    if (!record) throw new OutboxUsageError(`unknown outbox entry: ${mutationId}`)
    return record
  }

  /**
   * The only writer. Every state change goes through the pure table (an illegal
   * cell throws rather than coercing), is PERSISTED, and only then observed —
   * durability before observability, per ADR 6 D4.3.
   */
  private async transition(
    record: OutboxRecord,
    transition: Parameters<typeof applyOutboxTransition>[1],
    patch: Partial<OutboxRecord> & { reason?: OutboxRejectionReason | undefined },
  ): Promise<OutboxRecord> {
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
    this.replace(cleaned)
    await this.persist()
    return cleaned
  }

  private replace(record: OutboxRecord): void {
    const idx = this.records.findIndex((r) => r.mutationId === record.mutationId)
    if (idx === -1) this.records.push(record)
    else this.records[idx] = record
  }

  private async persist(): Promise<void> {
    await this.store.write([...this.records])
  }

  private emit(event: OutboxEvent): void {
    for (const listener of this.listeners) listener(event)
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
  ...(record.expectedRevision === undefined ? {} : { expectedRevision: record.expectedRevision }),
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
    ...(record.expectedRevision === undefined ? {} : { expectedRevision: record.expectedRevision }),
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
