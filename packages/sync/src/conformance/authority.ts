/**
 * ONE authority, N principals, ONE global sequence — the fixture half of POD-373.
 *
 * This is not a second copy of `replica/test-support.ts`'s `FakeAuthority`. That
 * one is SCRIPTED (a test hands it the frames it should return) and
 * single-principal, which is right for pinning the replica state machine and
 * cannot express half of this suite: a scripted authority cannot produce a
 * watermark BECAUSE a range was suppressed, so a test using it proves the replica
 * accepts watermarks and proves nothing about scoping. This one is DERIVED: a
 * global log plus a visibility predicate, from which watermarks fall out.
 *
 * FOUR PROPERTIES IT EXISTS TO MAKE TESTABLE:
 *
 * 1. **The suppression is real.** `frameFor` evaluates every seq in the covered
 *    range against the principal and emits exactly what that principal may see.
 *    A watermark is the residue of that evaluation, never a thing a test asked
 *    for — so "a watermark-only stretch does not heal" is a claim about scoping
 *    rather than about a literal a fixture supplied.
 * 2. **Global seq stays global** (Amendment 1 D12). Nothing is renumbered
 *    per-principal, and anchored per-principal rows SHARE the seq of the change
 *    that caused them (D14.3). There is no `instance_id` here and there must
 *    never be: multi-user is not multi-tenancy (ADR 1 D5).
 * 3. **Rights are resolved LIVE, at apply time, over the delegation chain**
 *    (ADR 3 D8 / amendment D16). `ConformanceTransport.submit` reads the policy at
 *    the moment of the attempt and holds no capability from the client, so
 *    "revoked while offline with queued writes" is decided by the authority when
 *    the drain arrives — which is the property the suite must PROVE, not assume.
 * 4. **No existence oracle** (readiness §3.1.5 / ADR 3 D20). `submit` reports
 *    `unauthorized` for an invisible target and `target-not-found` for a
 *    nonexistent one, and `normalizeRefusal` collapses both to one durable reason.
 *    Keeping them separate arms HERE is what lets the suite assert the collapse
 *    downstream instead of asserting it against a fixture that never distinguished
 *    them in the first place.
 *
 * The policy is a STUB, and deliberately so: this suite exercises the MECHANISM.
 * Phase 3 (POD-290) owns real share/unshare commands and real policy, and a stub
 * here is what stops this suite from encoding a policy Phase 3 has not decided.
 */

import type { MutationId } from '@podium/protocol'
import type { OutboxAttribution, UserRef } from '../outbox/records'
import type { OutboxEnvelope, OutboxSubmitOutcome, OutboxSubmitPort } from '../outbox/ports'
import type { AuthorityReadPort } from '../replica/ports'
import type {
  BootstrapChunk,
  ChangeEnvelope,
  ChangesSinceReply,
  Cursor,
  DeltaFrame,
} from '../replica/types'

export const FEED_ID = 'conformance-feed'
export const FIRST_EPOCH = 'epoch-1'

/** `entity:entityId`. The unit visibility is granted over in this stub. */
export type EntityKey = string
export const keyOf = (entity: string, entityId: string): EntityKey => `${entity}:${entityId}`

/**
 * A principal, as the authenticated TRANSPORT knows it (ADR 3 D7/D14).
 *
 * An agent is `(actorSessionId, onBehalfOf, scope)` and never a copied capability
 * (readiness §3.1.3 A1). Its `scope` is what it was SPAWNED FOR (A2), which is why
 * it is a set here rather than a mirror of its human's grants: a fixture that
 * modelled an agent as simply holding everything its human holds could not fail
 * the A2 assertion, and half the delegation cases would be vacuous.
 */
export type ConformancePrincipal =
  | { readonly kind: 'user'; readonly userId: UserRef }
  | {
      readonly kind: 'agent'
      readonly sessionId: string
      readonly onBehalfOf: UserRef
      /** A2 — the agent's own scope. Its human is a CEILING, not this set. */
      readonly scope: ReadonlySet<EntityKey>
    }

/**
 * A stable identity string for one principal.
 *
 * Needed because `transportFor` must be MEMOIZED: a fresh transport per call would
 * mean a test setting `transport.offline` was configuring an object the Outbox has
 * never seen, so every offline case would pass while the drain quietly succeeded —
 * an all-green probe measuring nothing. Keyed by value rather than by object
 * identity, so a principal rebuilt from a literal still reaches its own transport.
 */
export const idOf = (principal: ConformancePrincipal): string =>
  principal.kind === 'user' ? `user:${principal.userId}` : `agent:${principal.sessionId}`

/** The human at the root of the chain. Every principal has exactly one. */
export const humanOf = (principal: ConformancePrincipal): UserRef =>
  principal.kind === 'user' ? principal.userId : principal.onBehalfOf

/** The attribution PAIR this principal's writes are stamped with (A3 / ADR 3 D17). */
export const attributionOf = (principal: ConformancePrincipal): OutboxAttribution =>
  principal.kind === 'user'
    ? { actor: { kind: 'user', userId: principal.userId }, onBehalfOf: principal.userId }
    : {
        // `sessionId` is branded in `@podium/protocol`; the fixture is the one place
        // that mints one, so the cast is confined here rather than spread across cases.
        actor: { kind: 'agent-session', sessionId: principal.sessionId as never },
        onBehalfOf: principal.onBehalfOf,
      }

/**
 * The stub visibility policy: a grant set per HUMAN.
 *
 * Grants are held per human and never per agent, which is A1 expressed as a data
 * shape rather than as a check somebody has to remember: an agent has no grants of
 * its own to go stale, so revoking the human transitively disables the agent with
 * no reaper to write and none to forget.
 */
export class StubVisibilityPolicy {
  private readonly grants = new Map<UserRef, Set<EntityKey>>()
  /** Every key the authority has ever created, visible or not. Backs the no-oracle case. */
  private readonly existing = new Set<EntityKey>()

  /** Phase 3 owns the real command. This is the mechanism's test seam. */
  grant(user: UserRef, entity: string, entityId: string): void {
    const set = this.grants.get(user) ?? new Set<EntityKey>()
    set.add(keyOf(entity, entityId))
    this.grants.set(user, set)
  }

  revoke(user: UserRef, entity: string, entityId: string): void {
    this.grants.get(user)?.delete(keyOf(entity, entityId))
  }

  /** Private by default (readiness §3.1.1 rule 1): an unclassified key is invisible. */
  private granted(user: UserRef, key: EntityKey): boolean {
    return this.grants.get(user)?.has(key) === true
  }

  noteExists(entity: string, entityId: string): void {
    this.existing.add(keyOf(entity, entityId))
  }

  exists(entity: string, entityId: string): boolean {
    return this.existing.has(keyOf(entity, entityId))
  }

  /**
   * Effective visibility, resolved LIVE over the whole chain (A1): the agent's own
   * scope INTERSECTED with its human's CURRENT grants. Never a union, never the
   * human's set alone.
   */
  canSee(principal: ConformancePrincipal, entity: string, entityId: string): boolean {
    const key = keyOf(entity, entityId)
    if (!this.granted(humanOf(principal), key)) return false
    return principal.kind === 'user' || principal.scope.has(key)
  }

  /** What the principal's slice IS, right now. Used by bootstrap and by the exact-slice bound. */
  visibleKeys(principal: ConformancePrincipal): readonly EntityKey[] {
    const human = this.grants.get(humanOf(principal)) ?? new Set<EntityKey>()
    const keys = [...human]
    return principal.kind === 'user' ? keys : keys.filter((key) => principal.scope.has(key))
  }
}

/**
 * One row of the ONE global log.
 *
 * `audience` is present only for a per-principal ANCHORED row (D14.3): an `evict`
 * or a re-admitting `upsert` belongs to one principal and occupies the seq of the
 * grant change that caused it. Rows with no audience are ordinary entity changes,
 * filtered by the policy.
 */
interface LogRow {
  readonly seq: number
  readonly audience?: UserRef
  readonly change: ChangeEnvelope
}

/** A receipt the authority kept, so the suite can assert what it recorded. */
export interface ApplyReceipt {
  readonly mutationId: MutationId
  readonly seq: number
  /** Stamped from the TRANSPORT principal (ADR 3 D7). Never read from the envelope. */
  readonly attribution: OutboxAttribution
}

export class ConformanceAuthority {
  readonly feedId = FEED_ID
  epoch: string = FIRST_EPOCH
  readonly policy = new StubVisibilityPolicy()
  /** ADR 2 D5 — below this, a heal is refused and the ladder goes to rung 2. */
  minAvailableSeq = 0
  /** Queued per-principal control frames the suite drains deliberately. */
  private readonly pendingControl = new Map<UserRef, ('rescope' | 'resync-required')[]>()

  private rows: LogRow[] = []
  private seqCounter = 0
  /** Bootstrap walks currently in flight. Backs the reconnect-storm case. */
  concurrentBootstraps = 0
  peakConcurrentBootstraps = 0
  /** Chunks yielded, interleaved across principals. Proves bootstrap does not own the loop. */
  readonly chunkTrace: string[] = []
  bootstrapCalls = 0
  readonly receipts: ApplyReceipt[] = []
  /** Cursors `changesSince` was asked about, in order. Proves a heal was ATTEMPTED. */
  readonly changesSinceCalls: Cursor[] = []
  /** Chunk size. A tuning parameter, not a protocol constant (ADR 2 D6). */
  chunkSize = 2
  /**
   * Pin the snapshot point BELOW the head (ADR 2 D6: the snapshot is read at a
   * definite `(feedId, epoch, snapshotSeq)`, and nothing requires that to be the head).
   *
   * Needed to make a buffered frame INCLUDED in an install rather than dropped as
   * covered, which is the difference between exercising the install's multi-region
   * commit and never opening a transaction at all. Without it the bootstrap-install
   * crash case was an all-green probe: the confirming frame sat at the same seq as the
   * snapshot, so it was correctly discarded as covered, no retirement was owed, the
   * commit took the single-region autocommit arm and the injected failure was never
   * consumed. Measured, not assumed — `unitOfWorkTransactions()` moved by 0.
   */
  pinSnapshotSeq: number | null = null
  /**
   * Cap the upper bound of a `changesSince` reply below the head.
   *
   * D13.1 requires a reply's certified range to be contiguous with the cursor; it does
   * NOT require it to reach the head. Capping it is what lets a heal land the replica
   * exactly where a BUFFERED frame chains on, which is the only way to drive the
   * buffer-drain path with a frame that still owes a retirement. Without it a heal
   * always covers everything and every buffered frame is dropped as covered — so the
   * drain path's own commit would never be exercised.
   */
  changesSinceCeiling: number | null = null
  private readonly transports = new Map<string, ConformanceTransport>()

  head(): number {
    return this.seqCounter
  }

  /** Append an ordinary entity change to the ONE global sequence. */
  append(change: Omit<ChangeEnvelope, 'seq'>): number {
    this.seqCounter += 1
    if (change.op === 'upsert') this.policy.noteExists(change.entity, change.entityId)
    this.rows.push({ seq: this.seqCounter, change: { ...change, seq: this.seqCounter } })
    return this.seqCounter
  }

  /**
   * A grant. Burns ONE global seq (the grant edge is itself a durable change) and
   * anchors a re-admitting `upsert` for the affected principal at that same seq
   * (D14.2/D14.3).
   *
   * D14.2's point, restated because it looks wrong: the entity's `revision` does
   * NOT move. An upsert whose revision has not moved is still a valid upsert —
   * `revision` is an authority-assigned token the replica never arbitrates on.
   */
  grant(user: UserRef, entity: string, entityId: string): number {
    this.policy.grant(user, entity, entityId)
    this.seqCounter += 1
    const latest = this.latestUpsert(entity, entityId)
    if (latest !== undefined) {
      this.rows.push({
        seq: this.seqCounter,
        audience: user,
        change: { ...latest, seq: this.seqCounter },
      })
    }
    return this.seqCounter
  }

  /** A revoke. Burns one global seq and anchors an `evict` — NEVER a `remove` (D14.5). */
  revoke(user: UserRef, entity: string, entityId: string): number {
    this.policy.revoke(user, entity, entityId)
    this.seqCounter += 1
    this.rows.push({
      seq: this.seqCounter,
      audience: user,
      change: { seq: this.seqCounter, entity, entityId, op: 'evict' },
    })
    return this.seqCounter
  }

  /** ADR 2 D1 — a restore mints a NEW never-reused epoch. Compared by equality only. */
  bumpEpoch(next: string): void {
    this.epoch = next
  }

  /** ADR 2 D5 — head-prune. A cursor below this cannot heal (rung 2). */
  compactTo(seq: number): void {
    this.minAvailableSeq = seq
  }

  /** Queue a control frame for one principal. Amendment 1 D14.4 / ADR 2 D9. */
  queueControl(user: UserRef, kind: 'rescope' | 'resync-required'): void {
    const queue = this.pendingControl.get(user) ?? []
    queue.push(kind)
    this.pendingControl.set(user, queue)
  }

  takeControl(user: UserRef): 'rescope' | 'resync-required' | undefined {
    return this.pendingControl.get(user)?.shift()
  }

  /**
   * THE CERTIFIED FRAME (Amendment 1 D13): "I have evaluated every global seq in
   * `(fromSeq, seq]` against your principal, and `changes` contains exactly those
   * you may see."
   *
   * `changes` MAY be empty, and under private-by-default it usually is. That is not
   * an exception path here either — it is the same code with a filter that matched
   * nothing.
   */
  frameFor(principal: ConformancePrincipal, fromSeq: number, upTo = this.head()): DeltaFrame {
    const changes = this.rows
      .filter((row) => row.seq > fromSeq && row.seq <= upTo && this.mayDeliver(principal, row))
      .map((row) => row.change)
    return { kind: 'delta', feedId: this.feedId, epoch: this.epoch, fromSeq, seq: upTo, changes }
  }

  /** The read port ONE principal sees. There is no principal parameter on the port itself. */
  portFor(principal: ConformancePrincipal): AuthorityReadPort {
    return {
      changesSince: async (cursor: Cursor): Promise<ChangesSinceReply> => {
        this.changesSinceCalls.push(cursor)
        // Feed identity is checked by EQUALITY (D1). A restored backup re-serves the
        // same seqs under a new epoch, so seq comparison alone cannot see the
        // divergence — which is exactly the D1 case this suite owes.
        if (cursor.feedId !== this.feedId || cursor.epoch !== this.epoch) {
          return { kind: 'bootstrap-required', reason: 'feed identity changed' }
        }
        if (cursor.seq < this.minAvailableSeq) {
          return { kind: 'bootstrap-required', reason: 'compacted' }
        }
        const upTo =
          this.changesSinceCeiling === null
            ? this.head()
            : Math.min(this.changesSinceCeiling, this.head())
        return this.frameFor(principal, cursor.seq, upTo)
      },
      bootstrap: (): AsyncIterable<BootstrapChunk> => {
        this.bootstrapCalls += 1
        return this.walk(principal)
      },
    }
  }

  /**
   * An authenticated transport for ONE principal (ADR 3 D7).
   *
   * The principal is closed over rather than passed per submit, because that is the
   * property: an envelope carries no identity, so there is nowhere for a replay to
   * re-present one.
   */
  transportFor(principal: ConformancePrincipal): ConformanceTransport {
    const key = idOf(principal)
    const existing = this.transports.get(key)
    if (existing !== undefined) return existing
    const transport = new ConformanceTransport(this, principal)
    this.transports.set(key, transport)
    return transport
  }

  /**
   * Apply a command, with rights resolved LIVE at this instant (D8/D16).
   *
   * The target comes from the caller's own `input`; the ACTOR comes from the
   * transport. That split is D7: the input is the author's intent, the identity is
   * the connection's, and the two never swap roles.
   */
  applyCommand(
    principal: ConformancePrincipal,
    envelope: OutboxEnvelope,
  ): OutboxSubmitOutcome {
    const target = targetOf(envelope.input)
    if (target === undefined) {
      return { kind: 'rejected', refusal: { kind: 'invalid', details: ['input.entityId'] } }
    }
    const { entity, entityId, value } = target
    if (!this.policy.canSee(principal, entity, entityId)) {
      // TWO ARMS, ONE DURABLE REASON. The authority may know which it was — telemetry
      // legitimately wants it — and `normalizeRefusal` is where the distinction dies.
      // The suite asserts that collapse for equality rather than merely asserting both fail.
      return this.policy.exists(entity, entityId)
        ? { kind: 'rejected', refusal: { kind: 'unauthorized' } }
        : { kind: 'rejected', refusal: { kind: 'target-not-found' } }
    }
    const seq = this.append({
      entity,
      entityId,
      op: 'upsert',
      payload: value,
      mutationId: envelope.mutationId,
      causationId: envelope.mutationId,
    })
    this.receipts.push({
      mutationId: envelope.mutationId,
      seq,
      attribution: attributionOf(principal),
    })
    return { kind: 'applied' }
  }

  receiptFor(mutationId: MutationId): ApplyReceipt | undefined {
    return this.receipts.find((r) => r.mutationId === mutationId)
  }

  private mayDeliver(principal: ConformancePrincipal, row: LogRow): boolean {
    if (row.audience !== undefined) return row.audience === humanOf(principal)
    return this.policy.canSee(principal, row.change.entity, row.change.entityId)
  }

  private latestUpsert(entity: string, entityId: string): ChangeEnvelope | undefined {
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i] as LogRow
      const change = row.change
      if (change.entity === entity && change.entityId === entityId && change.op === 'upsert') {
        return change
      }
    }
    return undefined
  }

  /**
   * ADR 2 D6 / Amendment 1 D15 — the principal's SCOPED slice, chunked and PACED.
   *
   * Positive state only (D5's safety proof): what exists and is visible. A deleted
   * entity is absent, and an entity this principal may not see is ALSO absent —
   * which is why a missed `evict` heals exactly the way a missed tombstone heals
   * (D16.1), with no separate mechanism.
   *
   * `await Promise.resolve()` before each chunk is the pacing D6 requires ("the
   * bootstrap must never own the loop"), and it is what makes both the
   * frame-arrives-mid-walk case and the reconnect-storm case reachable at all.
   */
  private async *walk(principal: ConformancePrincipal): AsyncIterable<BootstrapChunk> {
    const who = humanOf(principal)
    this.concurrentBootstraps += 1
    this.peakConcurrentBootstraps = Math.max(
      this.peakConcurrentBootstraps,
      this.concurrentBootstraps,
    )
    try {
      const snapshotSeq = this.pinSnapshotSeq ?? this.head()
      const visible = new Set(this.policy.visibleKeys(principal))
      const rows: ChangeEnvelope[] = []
      const emitted = new Set<EntityKey>()
      // Newest first, so one row per entity: the snapshot is state, not history.
      for (let i = this.rows.length - 1; i >= 0; i -= 1) {
        const row = this.rows[i] as LogRow
        const change = row.change
        // A snapshot is state AT `snapshotSeq`, so a row above it is not in it.
        if (change.seq > snapshotSeq) continue
        const key = keyOf(change.entity, change.entityId)
        if (emitted.has(key) || !visible.has(key)) continue
        if (change.op !== 'upsert') continue
        emitted.add(key)
        rows.unshift(change)
      }
      if (rows.length === 0) {
        await Promise.resolve()
        this.chunkTrace.push(`${who}:empty`)
        yield { feedId: this.feedId, epoch: this.epoch, snapshotSeq, changes: [], last: true }
        return
      }
      for (let i = 0; i < rows.length; i += this.chunkSize) {
        await Promise.resolve()
        this.chunkTrace.push(`${who}:${i / this.chunkSize}`)
        yield {
          feedId: this.feedId,
          epoch: this.epoch,
          snapshotSeq,
          changes: rows.slice(i, i + this.chunkSize),
          last: i + this.chunkSize >= rows.length,
        }
      }
    } finally {
      this.concurrentBootstraps -= 1
    }
  }
}

/**
 * The submit half. Implements `OutboxSubmitPort` and nothing else, so the Outbox
 * sees exactly what it will see in production.
 */
export class ConformanceTransport implements OutboxSubmitPort {
  /** Every envelope this transport was handed. Backs the no-identity-on-the-wire assertion. */
  readonly envelopes: OutboxEnvelope[] = []
  /** Attempts per mutation, so a replay is observable. */
  private readonly attemptsById = new Map<string, number>()
  /** Set to make the transport unreachable — a transport failure, never a verdict. */
  offline = false

  constructor(
    private readonly authority: ConformanceAuthority,
    readonly principal: ConformancePrincipal,
  ) {}

  attempts(mutationId: MutationId): number {
    return this.attemptsById.get(mutationId) ?? 0
  }

  async submit(envelope: OutboxEnvelope): Promise<OutboxSubmitOutcome> {
    this.envelopes.push(envelope)
    this.attemptsById.set(envelope.mutationId, this.attempts(envelope.mutationId) + 1)
    // A transport failure is `unreachable` (D9 invariant 4: stay queued, retry until
    // the age limit) and is emphatically NOT a refusal. Conflating them is what turns
    // a blip into a lost write or a poison entry into an infinite retry.
    if (this.offline) return { kind: 'unreachable' }
    return this.authority.applyCommand(this.principal, envelope)
  }
}

/** The shape every conformance command's `input` takes. */
export interface CommandInput {
  readonly entity: string
  readonly entityId: string
  readonly value: unknown
}

const targetOf = (input: unknown): CommandInput | undefined => {
  if (typeof input !== 'object' || input === null) return undefined
  const candidate = input as Partial<CommandInput>
  if (typeof candidate.entity !== 'string' || typeof candidate.entityId !== 'string') {
    return undefined
  }
  return { entity: candidate.entity, entityId: candidate.entityId, value: candidate.value }
}
