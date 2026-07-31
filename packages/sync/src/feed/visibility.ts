/**
 * PER-PRINCIPAL VISIBILITY — the evaluation the scoped feed filters with
 * (POD-1077; ADR 2 Amendment 1 D12/D13, ADR 9 D2/D3/D4/D5).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 *
 * D12.7: *"the authority evaluates visibility; the replica never filters, never
 * re-checks, and never receives a row it may not see."* This module is that
 * evaluation, and it lives in the kernel rather than in a fixture for the reason
 * `conformance/binding.test.ts` gives at length: while the policy was a stub
 * inside the conformance fixture, every scoped gate was certifying the fixture.
 *
 * The split is:
 *
 *   THIS MODULE (kernel)   the DECISION — the class rules, the default-closed
 *                          backstop, the delegation intersection, and the
 *                          reason each refusal carries.
 *   {@link VisibilityStatePort} (injected)
 *                          the DATA — who owns what, which grant edges exist,
 *                          which visibility class an entity kind is declared
 *                          with. Owned by whoever holds the tables: the server
 *                          in production, the conformance fixture in the suite.
 *
 * It decides no product policy. Share/unshare COMMANDS are Phase 3's (POD-290);
 * what a grant edge looks like is POD-1075's (`@podium/model`'s `identity/grant`);
 * what class an entity kind is in is ADR 1's ownership matrix. This module reads
 * those three answers and combines them the one way the ADR pack specifies.
 *
 * ---------------------------------------------------------------------------
 * DEFAULT-CLOSED, WITH "NEVER CLASSIFIED" DISTINGUISHABLE FROM "PERSONAL"
 * ---------------------------------------------------------------------------
 *
 * ADR 9 D4 makes an undeclared class `personal`/private, and `visibilityClassOf`
 * in `@podium/model` is that semantic backstop. But a backstop that returns the
 * SAME answer for "deliberately personal" and "nobody ever classified this" is a
 * gate that cannot say NO to a whole entity class arriving unclassified — a
 * defect this run has already paid for once.
 *
 * So {@link VisibilityStatePort.classOf} returns `null` for an undeclared kind
 * and this module refuses it with the DISTINCT reason `unclassified`. Both
 * outcomes are "invisible", which is what keeps the failure safe; they are
 * separately observable, which is what lets a test, a gate and an operator's
 * telemetry tell a decision from an omission.
 *
 * ---------------------------------------------------------------------------
 * DELEGATION IS AN INTERSECTION, NEVER A UNION (ADR 9 D5 A1/A2)
 * ---------------------------------------------------------------------------
 *
 * An agent sees `its human's CURRENT rights ∩ the scope it was spawned for`.
 * Resolved live on every evaluation, because a frozen copy survives the
 * revocation of the person who issued it (A1), and bounded by the agent's own
 * scope, because an agent that simply inherited everything its human holds makes
 * the A2 assertion unfailable (A2).
 *
 * A grant is held against the HUMAN and never against the agent. That is A1 as a
 * data shape rather than as a check somebody has to remember: an agent has no
 * grants of its own to go stale, so revoking the human transitively disables the
 * agent with no reaper to write and none to forget.
 */

import type { VisibilityClass } from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
import type { UserRef } from '../outbox/records'

/**
 * One entity, as visibility asks about it. No payload: the decision never reads
 * content, so a policy cannot be steered by what a writer put in a field.
 *
 * `entity` is the LOGGED entity kind (`MetadataEntityKind`) and not a bare
 * string, so an anchored row derived from a subject is the same kind of thing as
 * a row that came out of the log — a subject naming a kind the Authority cannot
 * log is a compile error rather than a frame the replica rejects at runtime.
 */
export interface EntityRef {
  readonly entity: MetadataEntityKind
  readonly entityId: string
}

/** `entity:entityId` — the unit visibility is decided over. */
export type EntityKey = string

export const entityKey = (entity: string, entityId: string): EntityKey => `${entity}:${entityId}`
export const keyOfRef = (ref: EntityRef): EntityKey => entityKey(ref.entity, ref.entityId)

/**
 * What an agent principal was SPAWNED FOR (ADR 9 D5 A2).
 *
 * `all` exists because the delegation chain has a legitimate top — a human's own
 * connection is not scope-limited — and NOT as an escape hatch for agents: it is
 * unreachable from the `agent` arm below, which requires an explicit key set.
 */
export type DelegatedScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'entities'; readonly keys: ReadonlySet<EntityKey> }

/**
 * WHO a connection stands for (ADR 3 D7: from the authenticated transport only,
 * never from a payload).
 *
 * The agent arm carries `onBehalfOf` AND `scope` as separate fields, never one
 * collapsed capability: A1 needs the human to re-resolve against, A2 needs the
 * agent's own ceiling, and a single merged id can express neither.
 */
export type FeedPrincipal =
  | { readonly kind: 'user'; readonly userId: UserRef }
  | {
      readonly kind: 'agent'
      readonly sessionId: string
      readonly onBehalfOf: UserRef
      readonly scope: DelegatedScope
    }

/** The human at the root of the chain. Every principal has exactly one. */
export const humanOf = (principal: FeedPrincipal): UserRef =>
  principal.kind === 'user' ? principal.userId : principal.onBehalfOf

/** A stable id for one principal — used to key per-connection state and audiences. */
export const principalIdOf = (principal: FeedPrincipal): string =>
  principal.kind === 'user' ? `user:${principal.userId}` : `agent:${principal.sessionId}`

/**
 * Why a row was or was not delivered.
 *
 * Reasons are not decoration. `personal-not-granted` and `unclassified` are both
 * refusals and a caller that only sees `false` cannot tell a working default from
 * a missing declaration — see the file header.
 */
export type VisibilityReason =
  /** Owner or an explicit grant edge (ADR 9 D2). */
  | 'granted'
  /** ADR 9 D3 — tenant-visible substrate; every authenticated principal may see it. */
  | 'substrate'
  /** A declared personal/owned-compute class this principal holds no right on. */
  | 'personal-not-granted'
  /** ADR 9 D3 — one row per user; this principal is not the user in the key. */
  | 'per-user-state-not-yours'
  /** ADR 1 D6 — a secret NEVER replicates, grant or no grant. */
  | 'secret-never-replicates'
  /** ADR 9 D5 A2 — the human may see it; this agent was not spawned for it. */
  | 'outside-delegated-scope'
  /** ADR 9 D4 — no declared visibility class. Refused, and SAID so. */
  | 'unclassified'

export interface VisibilityDecision {
  readonly visible: boolean
  readonly reason: VisibilityReason
}

/**
 * WHAT KIND OF ANSWER A POLICY GIVES — declared by the policy itself (POD-376).
 *
 * Not a config string and not a deployment flag: a serving edge that needed to
 * know whether it is scoping must read the OBJECT that is actually installed, or
 * the two can drift and the drift is silent in the direction that matters. A
 * config saying `unscoped` beside a grant-edge policy is a wrong answer that
 * looks like a decision.
 *
 * The consumer is POD-376's rule that a client may not select a read path whose
 * wire cannot express `evict` while the authority can actually revoke. `evict` is
 * the whole difference: a `device-unscoped` policy has one principal, so nothing
 * is ever revoked from anybody and a wire with no eviction is complete. Against a
 * `per-principal` policy that same wire is a path that renders a row and then
 * dies on the first revoke — see `docs/agents/pod-376-shadow-comparison-basis.md`
 * §3.
 */
export type FeedScopingGrade =
  /** One principal; every authenticated connection sees the same slice. */
  | 'device-unscoped'
  /** Slices differ per principal; rows can enter and leave a view. */
  | 'per-principal'

/**
 * The DATA half, injected. Three questions, each answerable only by whoever holds
 * the tables.
 *
 * Deliberately not one `mayRead(user, ref)`: collapsing the three would move the
 * class rules into the adapter, where the secret prohibition and the
 * per-user-state key rule would be re-implemented per adapter — and the kernel
 * would have nothing left to be wrong about, which is another way of saying its
 * tests would prove nothing.
 */
export interface VisibilityStatePort {
  /**
   * The DECLARED visibility class of an entity kind, or `null` when the kind has
   * no declaration at all. `null` is refused as `unclassified`; it must never be
   * synthesised into `personal` here — see the file header.
   */
  classOf(entity: string): VisibilityClass | null
  /**
   * Does this HUMAN hold `read` on this entity — as owner, or through a grant
   * edge (ADR 9 D2)? Resolved live; never a cached capability (D5 A1).
   */
  mayRead(user: UserRef, ref: EntityRef): boolean
  /**
   * For a `per-user-state` row: the user in its `(userId, entityId)` key, or
   * `null` when the row does not carry one (which is malformed, and refused).
   */
  keyedUserOf(ref: EntityRef): UserRef | null
}

/**
 * The half of the data that turns a GRANT ROW into per-principal rows
 * (Amendment 1 D14.1/D14.2/D14.3).
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUTHORITY ASKS A PORT INSTEAD OF BEING TOLD
 * ---------------------------------------------------------------------------
 *
 * A revoke must reach the replica as `evict` and a grant as a re-admitting
 * `upsert`, and NOTHING about which one it is may come from the caller. A caller
 * that could say "send an evict for X to Y" is an oracle for what Y cannot see:
 * it would let a write path assert a visibility outcome the policy never agreed
 * to, and the resulting frame would be indistinguishable from a legitimate one.
 *
 * So the derivation is: this port says *which entities and which people a durable
 * row moved the visibility of*; {@link FeedVisibilityPolicy} then decides, per
 * principal and per subject, whether the answer is now yes (re-admit) or no
 * (evict). The op is a CONSEQUENCE of the policy, never an argument.
 *
 * `scoped-feed`'s audit and `authority.scoped.test.ts` both pin this: flipping
 * only the policy flips the op, and no input shape can name one.
 */
export interface VisibilityAnchorPort {
  /**
   * Did this durable row change who may see what? `null` for an ordinary entity
   * change, which is the overwhelmingly common answer.
   *
   * `audience` names the HUMANS whose view moved — not "everyone", because
   * telling an unaffected principal that an entity was evicted reveals the entity
   * exists (`docs/multi-user-readiness.md` §3.1.2's existence-leak class). An
   * unaffected principal sees that seq as a watermark, which is D14.3's own
   * prescription.
   */
  visibilityEdge(
    ref: EntityRef,
  ): { readonly audience: readonly UserRef[]; readonly subjects: readonly EntityRef[] } | null
  /**
   * The entity's CURRENT wire value, for a re-admitting `upsert` (D14.2), or
   * `undefined` when the entity no longer exists — in which case nothing is
   * re-admitted, because there is nothing to re-admit.
   *
   * D14.2's point restated, because it looks wrong: the entity's `revision` does
   * not move. An upsert whose revision has not moved is still a valid upsert.
   */
  currentValueOf(ref: EntityRef): unknown | undefined
}

/**
 * The evaluation ONE principal gets over ONE row.
 *
 * Kept as an interface with a single implementation on purpose: the publisher and
 * the scoped catch-up read take THIS type, so a deployment can supply a different
 * evaluator without either of them growing a second filtering site — and a test
 * can supply a deny-all or an allow-all to prove the filter is load-bearing.
 */
export interface FeedVisibilityPolicy {
  /**
   * What kind of answer this policy gives. REQUIRED, so a new policy cannot
   * arrive without declaring it — an optional field here would be read as
   * `?? 'device-unscoped'` at the one use site, and `device-unscoped` is exactly
   * the value that says "no wire needs to express an eviction". A policy that
   * forgot to declare would then be indistinguishable from one that cannot
   * revoke, and POD-376's gate would be present with its refusing arm
   * unreachable.
   */
  readonly grade: FeedScopingGrade
  decide(principal: FeedPrincipal, ref: EntityRef): VisibilityDecision
  mayDeliver(principal: FeedPrincipal, ref: EntityRef): boolean
}

/**
 * ADR 9's rules, in order, over an injected state port.
 *
 * The ORDER is load-bearing and is the reason this is one function rather than a
 * chain of predicates: the secret prohibition (ADR 1 D6) is evaluated BEFORE any
 * grant is consulted, so no grant can ever widen into it, and the unclassified
 * refusal is evaluated FIRST, so a missing declaration cannot be rescued by an
 * over-broad `mayRead`.
 */
export class GrantEdgeVisibilityPolicy implements FeedVisibilityPolicy {
  /** Rows enter and leave a principal's view here — every refusal reason below
   *  is reachable, and each one is an `evict` the moment the state moves. */
  readonly grade = 'per-principal' as const

  constructor(private readonly state: VisibilityStatePort) {}

  decide(principal: FeedPrincipal, ref: EntityRef): VisibilityDecision {
    const declared = this.state.classOf(ref.entity)
    if (declared === null) return { visible: false, reason: 'unclassified' }

    // ADR 1 D6 / ADR 9 D3: a secret does not replicate at all. Before grants,
    // because "it is not scoping, it is exclusion" (D12's rejected alternatives).
    if (declared === 'secret') return { visible: false, reason: 'secret-never-replicates' }

    const human = humanOf(principal)

    if (declared === 'per-user-state') {
      // ADR 9 D3: never shared and never grantable. The only admissible answer is
      // "you are the user in the key", so `mayRead` is not consulted — a grant
      // edge on a per-user-state row must not be able to widen it.
      const keyed = this.state.keyedUserOf(ref)
      if (keyed === null || keyed !== human) {
        return { visible: false, reason: 'per-user-state-not-yours' }
      }
      return this.underDelegation(principal, ref, 'granted')
    }

    if (declared === 'deployment-substrate') {
      return this.underDelegation(principal, ref, 'substrate')
    }

    // `personal` and `owned-compute`: owner or an explicit grant edge, live.
    if (!this.state.mayRead(human, ref)) {
      return { visible: false, reason: 'personal-not-granted' }
    }
    return this.underDelegation(principal, ref, 'granted')
  }

  mayDeliver(principal: FeedPrincipal, ref: EntityRef): boolean {
    return this.decide(principal, ref).visible
  }

  /**
   * A2's ceiling, applied LAST — the human's answer intersected with what this
   * agent was spawned for. Never a union: an agent may only ever see less.
   */
  private underDelegation(
    principal: FeedPrincipal,
    ref: EntityRef,
    reason: VisibilityReason,
  ): VisibilityDecision {
    if (principal.kind === 'user') return { visible: true, reason }
    const scope = principal.scope
    if (scope.kind === 'all') return { visible: true, reason }
    return scope.keys.has(keyOfRef(ref))
      ? { visible: true, reason }
      : { visible: false, reason: 'outside-delegated-scope' }
  }
}

/**
 * THE ONE PRINCIPAL A DEVICE-GRADE AUTHENTICATOR CAN PRODUCE, and the policy that
 * goes with it — named, exported and greppable rather than implicit.
 *
 * ---------------------------------------------------------------------------
 * WHY A PERMISSIVE POLICY EXISTS AT ALL, WHICH IS THE HONEST HALF OF POD-1077
 * ---------------------------------------------------------------------------
 *
 * POD-1075 landed real `UserAccount`s, per-user `client_sessions` and grants as
 * MODEL TYPES, so a principal is finally expressible. It did NOT land per-user
 * login: `packages/runtime/src/auth-store.ts` is still one shared password, and
 * `apps/server/src/gateway/client-principal.ts` still asserts
 * `CLIENT_PRINCIPAL_GRADE === 'device'`. Two connections presenting that password
 * are indistinguishable AS PERSONS.
 *
 * A filter is only as correct as the authenticator naming the principal it
 * filters for. Wiring the grant-edge policy onto a device-grade transport would
 * produce a system that LOOKS scoped and whose slices are decided by a credential
 * everyone shares — the worst of the two states, because it reads as privacy.
 *
 * So the mechanism ships filtering-and-watermarking together and complete, and
 * the one shipped composition root that has no person to filter for declares
 * THIS policy by name. `bun run audit:scoped-feed` holds the site list at exactly
 * the declared allowlist, so a second site cannot appear quietly; when per-user
 * login lands, deleting this export is what forces every site to name a real one.
 */
export const DEVICE_GRADE_PRINCIPAL: FeedPrincipal = {
  kind: 'user',
  userId: 'device:shared-instance-password',
}

/**
 * "Everyone" — for a transport that cannot tell two people apart.
 *
 * Not a `FeedVisibilityPolicy` written to look ordinary: the class name says what
 * it is, the reason it reports is `substrate` (there is exactly one principal, so
 * the whole instance IS its tenant view), and it is refused everywhere except the
 * audited allowlist.
 */
export class DeviceGradeUnscopedPolicy implements FeedVisibilityPolicy {
  /** One principal, so nothing is ever revoked from anybody: a wire with no way
   *  to say `evict` is COMPLETE against this policy, and POD-376's gate lets a
   *  legacy peer in. The day this export is deleted, that stops being true. */
  readonly grade = 'device-unscoped' as const

  decide(): VisibilityDecision {
    return { visible: true, reason: 'substrate' }
  }

  mayDeliver(): boolean {
    return true
  }
}

/**
 * The anchor port that goes with it: with one principal there is no share to
 * grant, so no durable row moves anyone's visibility and no anchored row is ever
 * derived.
 *
 * Stated as a port implementation rather than as an optional dependency, because
 * "absent" and "declares that nothing is grantable here" are different claims and
 * only the second one is checkable.
 */
export class DeviceGradeNoAnchors implements VisibilityAnchorPort {
  visibilityEdge(): null {
    return null
  }

  currentValueOf(): undefined {
    return undefined
  }
}
