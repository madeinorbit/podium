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

import type { Capability, SessionId, UserRole } from '@podium/model'
import { FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'

/**
 * THE INSTANCE'S ONE ACCOUNT — re-exported from `@podium/model`, which is now
 * its single home (POD-1075).
 *
 * This module used to declare `INSTANCE_OWNER = 'instance-owner'` here, with a
 * promise attached: *"when that table lands, this constant is replaced by a
 * lookup and every call site below is unchanged."* The table has landed. The
 * constant is now `FIRST_ADMIN_USER_ID` in `packages/model`'s
 * `identity/user.ts`, beside the `User` aggregate and the account role, and the
 * re-export is what keeps that promise — no call site in this app changed.
 *
 * WHY THE VALUE MOVED AND THE NAME WENT WITH IT (POD-1172). Two constants named
 * the one pre-accounts human and disagreed: this one, and `SOLE_USER_ID`
 * (`'user:sole'`) which `sessionOwner` stamps as every session's owner. Each was
 * internally consistent, so nothing compared them until POD-351's delegation
 * ceiling needed both — where, unreconciled, the intersection denied EVERY agent
 * write. `'user:sole'` won because it is the value the POD-380 migration already
 * WROTE INTO THE DATABASE for every pin, snooze and saved tab order, and a
 * migration is frozen history; this one was minted in memory and persisted
 * nowhere, so retiring it costs nothing. `rename-target-path.ts`'s
 * `samePrincipal` bridge and its tripwire are deleted with it.
 *
 * NOT a "default identity" — ADR 3 Amendment 1 D14's rule that there is no
 * default identity is about a principal being SYNTHESIZED for an unauthenticated
 * caller, and nothing here does that: an unauthenticated request never reaches a
 * resolver at all. This is the instance's one real account, and it now has a row
 * in `users` with `role = 'admin'`.
 */
export { FIRST_ADMIN_USER_ID }

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
   *  Today's provenance vocabulary is `spawnedBy: 'session:<id>'`. */
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
