/**
 * THE command principal — `(user, device, capability)` resolved from the
 * authenticated transport, with an agent's delegation chain walked LIVE
 * (ADR 3 D7, ADR 3 Amendment 1 D14/D16, docs/multi-user-readiness.md §3.1.3).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS NOW, BEFORE ACCOUNTS DO
 * ---------------------------------------------------------------------------
 *
 * POD-1075 has landed the `User` aggregate, the `users` table and the per-user
 * `client_sessions` column, so a person is now a real row. What has NOT changed
 * is the AUTHENTICATOR: `packages/runtime/src/auth-store.ts` is still one
 * password per instance, so every authenticated human still resolves to the SAME
 * person — the first admin. Per-user credentials and login are Phase 3
 * (POD-315), and until they land, `resolvePrincipal` returning one identity is
 * the honest answer rather than a placeholder.
 *
 * That is precisely why the resolution has to be a PORT rather than a constant.
 * ADR 3 Amendment 1's rejected-alternatives table says it directly: keeping
 * `OPERATOR` (role `admin`, scope `all`) as the tRPC principal and adding users
 * later means "every ownership check would be dead code on the one transport
 * humans actually use, so nothing would be tested until the flip". A port with a
 * single-user default is the same behaviour today and a POLICY CHANGE — not a
 * second migration — when accounts arrive.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `@podium/protocol`'s `Principal`, THOUGH IT LOOKS LIKE ONE
 * ---------------------------------------------------------------------------
 *
 * `planes/principal.ts` declares `UserPrincipal` / `AgentPrincipal` / … with
 * nearly these arms, and the next reader will reasonably suspect a fork. It is
 * not one, and the difference is a single field carrying the whole distinction:
 * there, `capability` is a `CapabilityRef` — an OPAQUE server-minted reference
 * the ports may carry and must never inspect, because "a port that could read a
 * scope out of it would be a port that could evaluate policy". Here it is the
 * live `Capability`, role and scope included, because THIS is the layer ADR 3 D8
 * charges with evaluating policy at every apply.
 *
 * Two types, one vocabulary, opposite obligations: the ports must not look, and
 * the command layer must. Collapsing them would either blind this module or hand
 * the transport ports a policy engine. Same-shaped is not same-fact.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *
 * No stored capability, no serialized rights, no "allow" bit. ADR 9 D5 A1 and
 * ADR 3 D16: effective rights are the agent's own scope INTERSECTED with its
 * human's CURRENT rights, resolved at every apply. A snapshot leaves an
 * unattended agent running with rights its human no longer holds, and nothing in
 * the system knows the copy exists. `packages/model`'s
 * `annotations/capability-snapshot.ts` enforces the same rule over schemas; this
 * module is the runtime half, and the shape below is a resolution INPUT, never a
 * cached decision.
 */

import { type Principal } from '@podium/protocol'
import type { Capability, SessionId, UserRole } from '@podium/model'
import { firstAdminMemberId, isAdminGrade, type UserId } from '@podium/model'

/**
 * THE INSTANCE'S FIRST ADMIN — re-exported from `@podium/model`, which is its
 * single home.
 *
 * This module used to declare `INSTANCE_OWNER = 'instance-owner'` here, with a
 * promise attached: *"when that table lands, this constant is replaced by a
 * lookup and every call site below is unchanged."* POD-1075 landed the table and
 * kept half of it — the constant became `FIRST_ADMIN_USER_ID`, still a constant,
 * just one spelled `'user:sole'` because that is what the POD-380 migration had
 * already written into every pin, snooze and saved tab order.
 *
 * A2 keeps the other half. `firstAdminMemberId()` is a LOOKUP now — the earliest
 * admin member of this instance, resolved from the database when the store opens
 * and read from there — because the migration gives that member an ordinary
 * `mem_` id minted per installation, so no build can name it. The call sites
 * below are, as promised, unchanged apart from the parentheses.
 *
 * NOT a "default identity" — ADR 3 Amendment 1 D14's rule that there is no
 * default identity is about a principal being SYNTHESIZED for an unauthenticated
 * caller, and nothing here does that: an unauthenticated request never reaches a
 * resolver at all. This is the instance's own first admin, a row in `users` with
 * `role = 'admin'`, and asking for it before any instance is open throws rather
 * than inventing one.
 */
export { firstAdminMemberId }

/** A person acting directly (tRPC cookie, local CLI, in-process MCP). */
export interface UserCommandPrincipal {
  readonly kind: 'user'
  readonly user: UserId
  readonly capability: Capability
}

/**
 * An agent session acting FOR exactly one human.
 *
 * `onBehalfOf` is resolved from the delegation record — never from payload,
 * where identity is inert (D7.1, strengthened by D14.3). `chain` is the
 * agent-session ancestry from this agent up to the root agent, nearest first; it
 * exists so the intersection of D16.2 is evaluated over the WHOLE chain rather
 * than over the leaf alone.
 */
export interface AgentCommandPrincipal {
  readonly kind: 'agent'
  readonly agentSessionId: SessionId
  readonly onBehalfOf: UserId
  readonly capability: Capability
  readonly chain: readonly SessionId[]
}

/**
 * An in-process job (steward, expiry, boot reconcile). ADR 3 Amendment 1 D21: it
 * may read across owners, but it has NO human and must never be assigned one,
 * and it is unreachable from every transport.
 */
export interface SystemCommandPrincipal {
  readonly kind: 'system'
  readonly job: string
}

export type CommandPrincipal = UserCommandPrincipal | AgentCommandPrincipal | SystemCommandPrincipal

/** Mint the live human principal from the authenticated account row. */
export function userCommandPrincipal(user: UserId, role: UserRole): UserCommandPrincipal {
  return {
    kind: 'user',
    user,
    capability: {
      role: role === 'admin' ? 'admin' : 'worker',
      scope: role === 'admin' ? { kind: 'all' } : { kind: 'owned', userId: user },
      actorUser: user,
      onBehalfOf: user,
    },
  }
}

/**
 * WHO MAY SATISFY AN ADMIN FLOOR — the ONE decision, read by all five sites
 * (PDM-299).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SETTLES, AND WHY IT HAD TO BE SETTLED SOMEWHERE
 * ---------------------------------------------------------------------------
 *
 * Before this function, five places decided "may this principal attempt an
 * admin-grade command" and they did not agree:
 *
 *   · `roleFloorFailure` below, `modules/fleet/authz.ts` and
 *     `modules/settings/authz.ts` resolved an agent through `onBehalfOf` to the
 *     delegating human's live store role, and therefore PERMITTED an admin's
 *     agent;
 *   · `modules/workflows`' `assertProfileWrite` reached the same answer by a
 *     different road — `relay.ts`'s `workflowCallerForCapability` reads
 *     `users.roleOf(onBehalfOf)` and sets `protectedWrite`, which
 *     `workflowPrincipal` turns into the `admin` grade — and therefore also
 *     PERMITTED an admin's agent, over the one transport agents can actually
 *     reach;
 *   · `modules/operations`' `assertActionAuthorized` compared
 *     `capability.role`, which `relay.ts` and `SessionAuthz` hard-code to
 *     `worker` on every live agent session, and therefore REFUSED every agent.
 *
 * FOUR PERMITTED AND ONE REFUSED, and the one that refused was refusing nobody:
 * all three `operations` contracts declare `exposure: ['trpc']` and the family
 * has no entry in `RELAY_ALLOWED`, so no agent can route there at all. The only
 * admin-floor contract an agent can reach in the whole surface is
 * `workflows.profileSave` (`SERVED_ON = ['trpc','relay']`), and it permitted.
 *
 * ---------------------------------------------------------------------------
 * THE RULING, AND THE ARGUMENT THAT CARRIES IT
 * ---------------------------------------------------------------------------
 *
 * An agent does NOT inherit its human's admin grade. ADR 9 D5 A2 is titled "the
 * human is a ceiling, not the default grant", and the sentence
 * `settings/authz.test.ts` pins — *"a member's agent must be refused exactly
 * where the member is"* — constrains the REFUSAL direction only; it follows from
 * A1's intersection and says nothing about whether an admin's agent is
 * permitted.
 *
 * But the argument that decided it does not depend on reading A2 that way, and
 * it is recorded here because it is the one that survives someone who reads A2
 * differently: NARROWING LATER IS A REGRESSION, WIDENING LATER IS A DELIBERATE
 * ACT WITH A MECHANISM THAT ALREADY EXISTS. Almost no agent transport reaches
 * these families today, so deciding CLOSED now costs one live grant
 * (`workflows.profileSave`, see below) and buys the property that the day a
 * transport does reach them they fail closed rather than inheriting a grade
 * nobody voted for. A2's `--outside-scope` / `overrideScope` →
 * `confirm-required` path is where a future explicit widening would go.
 *
 * THIS REMOVED A LIVE PERMISSION, and pretending otherwise would leave the next
 * reader unable to explain a behaviour change: before PDM-299 an admin's agent
 * could write an execution profile over the relay, and `engine.test.ts` asserted
 * that it could, by name. It cannot now. That is the whole user-visible effect
 * of this change.
 *
 * ---------------------------------------------------------------------------
 * A REASON, NOT A BOOLEAN
 * ---------------------------------------------------------------------------
 *
 * The two ways to be below an admin floor are not the same fact and must not
 * refuse with the same sentence. "Your account is not an admin" sends a person
 * to check their account; "you are an agent, and an agent does not inherit"
 * sends them to run the command themselves. A boolean would collapse them and
 * the refusal would misdirect exactly the caller whose human IS an admin.
 *
 * It leaks nothing: a caller already knows whether it is an agent.
 */
export type AdminFloorRefusal =
  /** An agent, whoever it acts for. The delegating human's grade is not read,
   *  because under the ruling above it cannot change the answer. */
  | 'delegated'
  /** A human with no admin-grade account — or no readable account at all. */
  | 'below-grade'

/**
 * The admin floor's answer for one principal, or `undefined` to proceed.
 *
 * Takes the KIND rather than a whole {@link CommandPrincipal} so the one caller
 * that has no `CommandPrincipal` to hand — `WorkflowAccess`, whose fixture path
 * carries only the actor half — goes through this function instead of spelling
 * the rule a sixth time. See `workflowPrincipalKind`.
 *
 * ONLY THE ADMIN FLOOR IS SHARED. The `member` floor is deliberately NOT
 * decided here, because the three gates genuinely disagree about it for
 * documented reasons: this file leaves it alone entirely (header point 1 — the
 * 149-contract widening), while `fleet` and `settings` refuse a principal with
 * no readable account. Folding those together would be a behaviour change
 * smuggled in beside an unrelated one.
 */
export function adminFloorRefusal(
  kind: CommandPrincipal['kind'],
  role: UserRole | undefined,
): AdminFloorRefusal | undefined {
  switch (kind) {
    case 'system':
      // A SYSTEM principal is constructed in-process and is unreachable from
      // every transport (ADR 3 Amendment 1 D21.2). It has no account, so it
      // satisfies no floor by the `user` arm below — the carve-out is here
      // rather than by inventing a role for it, because "the steward is an
      // admin" is exactly the service account ADR 9 D8 S5 rejects.
      return undefined
    case 'agent':
      // THE RULING. Note what is NOT read: the delegating human's role. Reading
      // it and then ignoring it would leave the next reader unsure whether the
      // refusal was the rule or a lookup that failed.
      return 'delegated'
    case 'user':
      // `undefined` is not a role — it is "no readable, enabled account" — and
      // it satisfies no floor.
      return role !== undefined && isAdminGrade(role) ? undefined : 'below-grade'
    default: {
      // A fourth principal kind is a DECISION about delegation, not a case to
      // fall through. Compile error rather than silent pass, the same shape
      // `roleFloorFailure` uses for a third floor value.
      const unreachable: never = kind
      throw new Error(`unhandled principal kind: ${String(unreachable)}`)
    }
  }
}

/**
 * The family's own refusal sentence, with the delegation clause appended when
 * that is what decided.
 *
 * The BASE stays each family's existing product text — `settings` says
 * "requires an ${floor} account", `workflows` says "only an administrator may
 * change execution profiles" — because the deliverable is one RULE, not one
 * vocabulary, and rewriting five shipped strings would be churn that hides the
 * one line that matters. The delegation clause is a single shared string, so
 * the new arm reads identically wherever it fires.
 */
export function adminFloorMessage(base: string, refusal: AdminFloorRefusal): string {
  return refusal === 'delegated'
    ? `${base} — and an agent does not inherit its human's admin grade`
    : base
}

/** The human behind a principal, or `null` where there deliberately is none. */
export function onBehalfOfUser(principal: CommandPrincipal): UserId | null {
  switch (principal.kind) {
    case 'user':
      return principal.user
    case 'agent':
      return principal.onBehalfOf
    case 'system':
      // Representable "none", never defaulted to an operator or to a row's
      // owner (ADR 3 Amendment 1 D17.5 / D21.2).
      return null
  }
}

/**
 * ADR 3 D17's attribution PAIR for this principal: which agent acted, and which
 * human it acted for. Both halves come from here — i.e. from the transport —
 * so no handler is ever tempted to read either from its input.
 */
export interface CommandAttribution {
  /** The actor half. `session:<id>` for an agent, matching today's `spawnedBy`
   *  vocabulary; `system:<job>` for a system job; the user id for a human. */
  readonly actor: string
  readonly onBehalfOf: UserId | null
}

export function attributionOf(principal: CommandPrincipal): CommandAttribution {
  switch (principal.kind) {
    case 'user':
      return { actor: principal.user, onBehalfOf: principal.user }
    case 'agent':
      return { actor: `session:${principal.agentSessionId}`, onBehalfOf: principal.onBehalfOf }
    case 'system':
      return { actor: `system:${principal.job}`, onBehalfOf: null }
  }
}

/**
 * What the resolver needs to know about the world. Both members are read LIVE at
 * every resolution, which is the whole mechanism of D16: there is nothing to
 * invalidate because there is nothing cached.
 */
export interface DelegationIndex {
  /** The session that spawned this one, if it was spawned by another session.
   *  Read with `spawnedByParentSessionId` — the one reader of the `spawnedBy`
   *  tag (POD-1133); nothing here matches the string itself. */
  parentSessionOf(sessionId: SessionId): SessionId | undefined
  /** The human a root agent session was spawned for. Absent ⇒ the instance's
   *  one account, which is the only answer available before POD-1075. */
  onBehalfOfFor?(sessionId: SessionId): UserId | undefined
}

/** Chain depth ceiling. A cycle in `spawnedBy` would otherwise hang the resolve;
 *  this is a fail-loud bound, not a policy about how deep agents may nest. */
const MAX_CHAIN_DEPTH = 64

/**
 * Resolve the transport principal for a call that arrived with `capability`.
 *
 * Today's two shapes map exactly onto D14's table: a capability with an
 * `actorSessionId` is the daemon-authenticated relay path (an agent), and one
 * without is the cookie/in-process operator channel (a human). Neither reads
 * anything from payload.
 */
export interface AsyncDelegationIndex {
  parentSessionOf(sessionId: SessionId): SessionId | undefined | Promise<SessionId | undefined>
  onBehalfOfFor?(sessionId: SessionId): UserId | undefined | Promise<UserId | undefined>
}

/** Resolve a principal where the live delegation index reads durable async state. */
export async function resolvePrincipalAsync(
  capability: Capability,
  delegations: AsyncDelegationIndex,
): Promise<CommandPrincipal> {
  const actorSessionId = capability.actorSessionId
  if (actorSessionId === undefined) {
    const user = capability.onBehalfOf
    if (user === undefined || capability.actorUser !== user) {
      throw new Error('human capability has no authenticated user attribution')
    }
    return { kind: 'user', user, capability }
  }
  const chain: SessionId[] = []
  let cursor = await delegations.parentSessionOf(actorSessionId)
  while (cursor !== undefined && chain.length < MAX_CHAIN_DEPTH) {
    if (cursor === actorSessionId || chain.includes(cursor)) break
    chain.push(cursor)
    cursor = await delegations.parentSessionOf(cursor)
  }
  const root: SessionId = chain[chain.length - 1] ?? actorSessionId
  const onBehalfOf = (await delegations.onBehalfOfFor?.(root)) ?? capability.onBehalfOf
  if (onBehalfOf === undefined) {
    throw new Error(`agent capability has no delegation owner: ${actorSessionId}`)
  }
  return { kind: 'agent', agentSessionId: actorSessionId, onBehalfOf, capability, chain }
}

export function resolvePrincipal(
  capability: Capability,
  delegations: DelegationIndex,
): CommandPrincipal {
  const actorSessionId = capability.actorSessionId
  if (actorSessionId === undefined) {
    const user = capability.onBehalfOf
    if (user === undefined || capability.actorUser !== user) {
      throw new Error('human capability has no authenticated user attribution')
    }
    return { kind: 'user', user, capability }
  }
  const chain: SessionId[] = []
  let cursor: SessionId | undefined = delegations.parentSessionOf(actorSessionId)
  while (cursor !== undefined && chain.length < MAX_CHAIN_DEPTH) {
    if (cursor === actorSessionId || chain.includes(cursor)) break
    chain.push(cursor)
    cursor = delegations.parentSessionOf(cursor)
  }
  // D16.2: exactly ONE human, at the ROOT of the chain. Reading it off the leaf
  // would let a sub-agent carry a delegator its parent does not have.
  const root: SessionId = chain[chain.length - 1] ?? actorSessionId
  const onBehalfOf = delegations.onBehalfOfFor?.(root) ?? capability.onBehalfOf
  if (onBehalfOf === undefined) {
    throw new Error(`agent capability has no delegation owner: ${actorSessionId}`)
  }
  return { kind: 'agent', agentSessionId: actorSessionId, onBehalfOf, capability, chain }
}

/** A system principal. Constructed in-process only — it has no transport row. */
export function systemPrincipal(job: string): SystemCommandPrincipal {
  return { kind: 'system', job }
}
