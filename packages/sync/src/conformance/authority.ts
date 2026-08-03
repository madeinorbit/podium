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
 * ---------------------------------------------------------------------------
 * THE POLICY IS NO LONGER A STUB (POD-1077)
 * ---------------------------------------------------------------------------
 *
 * It used to be, and `binding.test.ts` recorded that honestly: *"the log, the
 * clock and the visibility policy are the fixture's"*. The decision half has now
 * moved into the kernel, so what is left here is the DATA — who was granted what,
 * which kinds are classified, what a grant row moves — and every `canSee` runs
 * through the shipped {@link GrantEdgeVisibilityPolicy}.
 *
 * That is the same re-homing POD-306 did for feed identity and the send queue,
 * applied to the last property this fixture was certifying on the kernel's
 * behalf. It matters for one specific reason: a fixture's own predicate cannot
 * fail the way the product fails. With the shipped evaluator on the path, the
 * seven scoped gates now break if the class rules break — an unclassified kind
 * silently becoming visible, a secret riding a grant, an agent's scope widening
 * to its human's — none of which a hand-rolled `grants.has(key)` could ever
 * notice.
 *
 * What is still deliberately absent is PRODUCT POLICY: share/unshare commands
 * are Phase 3's (POD-290), and this fixture's `grant`/`revoke` are test seams for
 * moving the table, not the commands that will do it.
 */

import {
  asAgentIdentityId,
  asCapabilityRef,
  asDelegationRef,
  asDeviceId,
  type Principal,
  principalRoutingId,
} from '@podium/protocol'
import {
  actorUser,
  asSessionId,
  asUserId,
  type MutationId,
  type VisibilityClass,
} from '@podium/model'
import { MetadataEntityKind } from '@podium/protocol'
import {
  BoundedSendQueue,
  type DelegatedScope,
  type DelegationScopePort,
  type EntityRef,
  type EpochBumpCause,
  type FeedIdentity,
  FeedIdentityRegistry,
  type FeedIdentityStore,
  GrantEdgeVisibilityPolicy,
  type VisibilityStatePort,
} from '../feed'
import type { OutboxEnvelope, OutboxSubmitOutcome, OutboxSubmitPort } from '../outbox/ports'
import { humanOf as kernelHumanOf } from '../feed/visibility'
import { agentActorOfSession, type OutboxAttribution, type UserRef } from '../outbox/records'
import type { AuthorityReadPort } from '../replica/ports'
import type {
  BootstrapChunk,
  ChangeEnvelope,
  ChangesSinceReply,
  Cursor,
  DeltaFrame,
  ResyncRequiredFrame,
} from '../replica/types'

export const FEED_ID = 'conformance-feed'

/**
 * Opaque epochs, in the order this fixture mints them (ADR 2 D1).
 *
 * ULIDs and not `'epoch-1'`, `'epoch-2'`, because the SHIPPED
 * `assertOpaqueEpoch` refuses a decimal counter and this fixture now goes through
 * it. A suite whose fixture could not satisfy the shipped guard would be a suite
 * exercising a different rule from the product.
 */
const EPOCHS = [
  '01JQ0Q1ZERO0FIRSTEPOCHAAAA',
  '01JQ0Q2ZONE1SECONDEPOCHBBB',
  '01JQ0Q3ZTWO2THIRDEPOCHCCCC',
  '01JQ0Q4ZTRE3FOURTHEPOCHDDD',
] as const

/**
 * The first epoch this fixture publishes.
 *
 * Exported for the suite's assertions, and DERIVED from the mint sequence rather
 * than declared beside it: two constants that must agree is one constant and a
 * convention, and the convention is what rots.
 */
export const FIRST_EPOCH: string = EPOCHS[0]

/** `entity:entityId`. The unit visibility is granted over in this stub. */
export type EntityKey = string
export const keyOf = (entity: string, entityId: string): EntityKey => `${entity}:${entityId}`

/**
 * A principal, as the authenticated TRANSPORT knows it (ADR 3 D7/D14) — THE
 * KERNEL'S TYPE, not a fixture's copy of it.
 *
 * It was a local union until POD-1077, which is the same "certifying the fixture"
 * hazard one field down: a suite whose principal is its own shape can be scoped
 * by rules the product does not have. Aliasing the shipped `Principal` means
 * the delegation arm the suite exercises is the one the kernel evaluates.
 *
 * An agent is `(actorSessionId, onBehalfOf, scope)` and never a copied capability
 * (readiness §3.1.3 A1); its `scope` is what it was SPAWNED FOR (A2), and its
 * human is a CEILING rather than the same set.
 */
export type ConformancePrincipal = Principal

/**
 * Build the two principal shapes this suite uses, so no test restates the
 * transport fields (`device`, `capability`) that it does not care about and
 * cannot get wrong here.
 */
export const conformanceUser = (id: string): ConformancePrincipal => ({
  kind: 'user',
  user: asUserId(id),
  device: asDeviceId(`dev:${id}`),
  capability: asCapabilityRef(`cap:${id}`),
})

export const conformanceAgent = (
  agentIdentity: string,
  onBehalfOf: string,
  delegation: string,
): ConformancePrincipal => ({
  kind: 'agent',
  agentIdentity: asAgentIdentityId(agentIdentity),
  onBehalfOf: asUserId(onBehalfOf),
  device: asDeviceId(`dev:${agentIdentity}`),
  capability: asCapabilityRef(`cap:${agentIdentity}`),
  // The REF only. What it was minted for lives in StubVisibilityPolicy.
  delegation: asDelegationRef(delegation),
})

/**
 * A stable identity string for one principal.
 *
 * Needed because `transportFor` must be MEMOIZED: a fresh transport per call would
 * mean a test setting `transport.offline` was configuring an object the Outbox has
 * never seen, so every offline case would pass while the drain quietly succeeded —
 * an all-green probe measuring nothing. Keyed by value rather than by object
 * identity, so a principal rebuilt from a literal still reaches its own transport.
 */
export const idOf = (principal: ConformancePrincipal): string => principalRoutingId(principal)

/**
 * The human at the root of the chain, or `null` where there is none.
 *
 * Re-exported from the kernel rather than restated (POD-1196): a fixture with its
 * own notion of "whose is this?" is a fixture that can be scoped by a rule the
 * product does not have, which is the hazard this file's own header describes.
 */
export const humanOf = kernelHumanOf

/**
 * The human, REQUIRED. Throws for a machine or system principal.
 *
 * Every fixture call site here is a per-human table lookup (a storage view, an
 * outbox owner, a grant set), and those are meaningless without one. Throwing
 * says so; defaulting to some placeholder user would silently file one
 * principal's rows under another's, which is the leak this suite exists to
 * detect (`docs/multi-user-readiness.md` §3.1).
 */
export const requireHuman = (principal: ConformancePrincipal): UserRef => {
  const human = kernelHumanOf(principal)
  if (human === null) throw new Error(`a ${principal.kind} principal has no human`)
  return human
}

/** The attribution PAIR this principal's writes are stamped with (A3 / ADR 3 D17). */
export const attributionOf = (principal: ConformancePrincipal): OutboxAttribution =>
  principal.kind === 'user'
    ? { actor: actorUser(asUserId(principal.user)), onBehalfOf: asUserId(principal.user) }
    : principal.kind !== 'agent'
      ? // A machine or system principal writes nothing in this suite; it has no
        // human, and D14.2/D21 forbid inventing one.
        (() => {
          throw new Error(`no attribution for a ${principal.kind} principal`)
        })()
      : {
        // `Principal` still carries raw strings (POD-1075 owns that flip), so
        // this fixture is where they enter the branded space. `asSessionId` then
        // `agentActorOfSession` rather than a cast to the actor brand: POD-1164's
        // rule is that the reclassification is always NAMED, so no call site can
        // invent a second agent id space by accident.
          actor: agentActorOfSession(asSessionId(principal.agentIdentity)),
          onBehalfOf: asUserId(principal.onBehalfOf),
        }

/**
 * The visibility TABLES: a grant set per HUMAN, plus the declared classes.
 *
 * Grants are held per human and never per agent, which is A1 expressed as a data
 * shape rather than as a check somebody has to remember: an agent has no grants of
 * its own to go stale, so revoking the human transitively disables the agent with
 * no reaper to write and none to forget.
 *
 * The DECISION is not here (POD-1077). `canSee` delegates to the shipped
 * {@link GrantEdgeVisibilityPolicy}, which owns the class rules, the
 * default-closed refusal and the delegation intersection; this class owns only
 * what a deployment's tables would own. `binding.test.ts` asserts the delegation
 * by object identity, so it cannot quietly grow its own predicate again.
 */
export class StubVisibilityPolicy implements VisibilityStatePort, DelegationScopePort {
  /**
   * What each delegation was minted for (ADR 9 D5 A2), keyed by its ref.
   *
   * It moved OFF the principal (POD-1196): the transport principal carries an
   * opaque `delegation` the ports must never inspect, so the ceiling lives here
   * and is resolved live on every decide.
   */
  private readonly scopes = new Map<string, DelegatedScope>()

  /** Test seam: mint a delegation with a scope. */
  delegate(delegation: string, scope: DelegatedScope): void {
    this.scopes.set(delegation, scope)
  }

  /**
   * DEFAULT-CLOSED for an unknown ref: an empty key set, so an agent presenting a
   * delegation this fixture never minted sees NOTHING. Returning `all` would make
   * every A2 assertion pass by accident, which is the shape of fixture bug that
   * certifies itself.
   */
  scopeOf(delegation: string): DelegatedScope {
    return this.scopes.get(delegation) ?? { kind: 'entities', keys: new Set() }
  }

  private readonly grants = new Map<UserRef, Set<EntityKey>>()
  /** Every key the authority has ever created, visible or not. Backs the no-oracle case. */
  private readonly existing = new Set<EntityKey>()
  /**
   * The DECLARED class of each entity kind this fixture logs.
   *
   * Declared per kind rather than defaulted, because the kernel refuses an
   * undeclared kind as `unclassified` — a refusal this fixture must be able to
   * produce (and does, for any kind not in this map) rather than paper over.
   */
  private readonly classes = new Map<string, VisibilityClass>([
    ['issue', 'personal'],
    ['session', 'personal'],
    ['conversation', 'personal'],
  ])

  /** The kernel's evaluator, over THIS fixture's tables. */
  readonly evaluator = new GrantEdgeVisibilityPolicy(this, this)

  classOf(entity: string): VisibilityClass | null {
    return this.classes.get(entity) ?? null
  }

  mayRead(user: UserRef, ref: EntityRef): boolean {
    return this.granted(user, keyOf(ref.entity, ref.entityId))
  }

  /** No `per-user-state` rows in this fixture's log, so nothing is keyed to a user. */
  keyedUserOf(): UserRef | null {
    return null
  }

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
   * Effective visibility, resolved LIVE over the whole chain (A1) — BY THE SHIPPED
   * EVALUATOR.
   *
   * The intersection with the agent's own scope, the class rules and the
   * default-closed refusal all live in `feed/visibility.ts` now. What is left here
   * is the call, and the narrowing of a log row's plain `string` entity to a kind
   * the Authority can actually log: `parse` rather than a cast, so a fixture that
   * invented a kind fails loudly instead of being silently classified.
   */
  canSee(principal: ConformancePrincipal, entity: string, entityId: string): boolean {
    return this.evaluator.decide(principal, {
      entity: MetadataEntityKind.parse(entity),
      entityId,
    }).visible
  }

  /** What the principal's slice IS, right now. Used by bootstrap and by the exact-slice bound. */
  visibleKeys(principal: ConformancePrincipal): readonly EntityKey[] {
    const human = this.grants.get(requireHuman(principal)) ?? new Set<EntityKey>()
    // Filtered through the same evaluator as the live path, so the bootstrap
    // slice and the delta slice cannot disagree — a second predicate here is
    // exactly how a replica installs a snapshot its deltas then contradict.
    return [...human].filter((key) => {
      const [entity, entityId] = splitKey(key)
      return this.canSee(principal, entity, entityId)
    })
  }
}

/** `entity:entityId` back into its two halves. The id may contain no colon rule
 *  is not assumed: only the FIRST separator splits. */
function splitKey(key: EntityKey): [string, string] {
  const at = key.indexOf(':')
  return [key.slice(0, at), key.slice(at + 1)]
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
  /**
   * FEED IDENTITY COMES FROM THE SHIPPED REGISTRY, NOT FROM THIS FIXTURE.
   *
   * This is the binding POD-305 used on the ownership matrix, applied to the other
   * half of the phase. Before it, `feedId` and `epoch` were two fields on this
   * class and `bumpEpoch` took the next epoch as a STRING ARGUMENT — so the D1
   * gate proved that a Replica compares two strings a test handed it, and proved
   * nothing about whether any authority in this system can mint a fresh epoch.
   * The suite was certifying the fixture.
   *
   * Now the fixture owns the LOG and the visibility policy (its legitimate
   * territory, since POD-1077 owns real scoping) and delegates identity to
   * `FeedIdentityRegistry`. `conformance-binding.test.ts` asserts the delegation
   * by object identity, and fails FIRST if it is absent — so this file cannot
   * quietly drift back to two fields without the guard going red.
   */
  private readonly identityStore: FeedIdentityStore & { held: FeedIdentity | null } = {
    held: null,
    readIdentity() {
      return this.held
    },
    writeIdentity(identity) {
      this.held = identity
    },
  }
  private mintIndex = 0
  readonly identity = new FeedIdentityRegistry(this.identityStore, () => {
    // The feedId is minted first and is stable; epochs come from the sequence.
    if (this.mintIndex === 0) {
      this.mintIndex += 1
      return FEED_ID
    }
    const epoch = EPOCHS[this.mintIndex - 1]
    if (epoch === undefined) throw new Error('conformance fixture ran out of epochs')
    this.mintIndex += 1
    return epoch
  })

  get feedId(): string {
    return this.identity.current().feedId
  }

  get epoch(): string {
    return this.identity.current().epoch
  }

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

  /**
   * ADR 2 D1 — a restore mints a NEW never-reused epoch. Compared by equality only.
   *
   * Takes a CAUSE and returns the epoch it minted. It used to take the epoch, and
   * the difference is the whole point of the re-homing: a caller supplying the new
   * value proves nothing about minting, and a test asserting `toBe('epoch-2')`
   * asserts that its own literal came back. Now the suite must ask what was
   * minted, which is a question only a working mint can answer.
   */
  bumpEpoch(cause: EpochBumpCause): string {
    return this.identity.bump(cause).epoch
  }

  /**
   * ADR 2 D9 — the BOUNDED OUTBOUND QUEUE, per principal, and the demotion that
   * falls out of overflowing it.
   *
   * Reached rather than requested. The slow-consumer gate used to hand the Replica
   * a `resync-required` literal it had written itself, so it certified that the
   * Replica converges FROM a demotion while nothing in the system could produce
   * one — "green against a server serving nothing", one layer up. Driving a real
   * `BoundedSendQueue` past its bound means the gate now fails if the queue stops
   * demoting, which is the property it was always credited with testing.
   *
   * The bound is deliberately tiny: this fixture is proving that the mechanism
   * fires and that the replica converges afterwards, not that any particular
   * number of bytes is the right bound. ADR 2 D9 leaves the number to deployment.
   */
  private readonly sendQueues = new Map<UserRef, BoundedSendQueue>()

  sendQueueFor(user: UserRef): BoundedSendQueue {
    const existing = this.sendQueues.get(user)
    if (existing !== undefined) return existing
    const queue = new BoundedSendQueue({ maxBytes: 2, sizeOf: () => 1 })
    this.sendQueues.set(user, queue)
    return queue
  }

  /**
   * Offer a frame to one principal's outbound queue, exactly as a transport would.
   *
   * Returns the control frame when the offer demoted the connection, so a case can
   * feed the replica what the AUTHORITY produced instead of what the case imagined.
   */
  offerTo(user: UserRef, frame: DeltaFrame): ResyncRequiredFrame | null {
    const admission = this.sendQueueFor(user).offer(frame)
    return admission.kind === 'demoted' ? admission.frame : null
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
    // ADR 2 D5 — the floor this fixture actually prunes to, not a constant. It is
    // read from the same field `changesSince` refuses below, so a case that moves
    // the floor moves BOTH the proactive signal and the reactive refusal, and a
    // replica that ignored the published floor would still be caught by the
    // refusal (and vice versa) rather than by neither.
    return {
      kind: 'delta',
      feedId: this.feedId,
      epoch: this.epoch,
      fromSeq,
      seq: upTo,
      minAvailableSeq: this.minAvailableSeq,
      changes,
    }
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
  applyCommand(principal: ConformancePrincipal, envelope: OutboxEnvelope): OutboxSubmitOutcome {
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
