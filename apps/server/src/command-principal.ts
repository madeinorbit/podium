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

import { createLogger } from '@podium/logger'
import type { Capability, SessionId, UserRole, WorkspaceId } from '@podium/model'
import { firstAdminMemberId, type UserId } from '@podium/model'
import { TRPCError } from '@trpc/server'

const log = createLogger('server:principal')

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

/**
 * EVERY PRINCIPAL NAMES ITS WORKSPACE (POD-7483, design 4.2).
 *
 * One server process serves many workspaces, so "who is asking" is never
 * enough on its own: a member of workspace A is nobody in workspace B. The
 * workspace is stamped where the principal is made, from the workspace the edge
 * bound the request to or the store a job runs over, and never read from
 * payload. Every command compares it with the workspace of the store it runs
 * over ({@link actsIn}) and refuses a principal from another one.
 */
interface WorkspaceBound {
  readonly workspaceId: WorkspaceId
}

/** A person acting directly (tRPC cookie, local CLI, in-process MCP). */
export interface UserCommandPrincipal extends WorkspaceBound {
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
export interface AgentCommandPrincipal extends WorkspaceBound {
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
 *
 * It reads across owners WITHIN ONE WORKSPACE: a job runs over one workspace's
 * store and its principal names that workspace, so a job can never act in a
 * workspace it was not started for.
 */
export interface SystemCommandPrincipal extends WorkspaceBound {
  readonly kind: 'system'
  readonly job: string
}

export type CommandPrincipal = UserCommandPrincipal | AgentCommandPrincipal | SystemCommandPrincipal

/** Mint the live human principal from the authenticated account row. */
export function userCommandPrincipal(
  workspaceId: WorkspaceId,
  user: UserId,
  role: UserRole,
): UserCommandPrincipal {
  return {
    kind: 'user',
    workspaceId,
    user,
    capability: {
      workspaceId,
      role: role === 'admin' ? 'admin' : 'worker',
      // One member scope for every person (design §4.1, POD-6288): an admin is
      // a member plus the admin role's actions, never an unscoped bypass.
      scope: { kind: 'owned', userId: user },
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
 * What the resolver needs to know about the store it resolves in. Every member
 * is read LIVE at every resolution, which is the whole mechanism of D16: there
 * is nothing to invalidate because there is nothing cached.
 *
 * Every member answers for THIS store's workspace only (POD-7558). That is why
 * `onBehalfOfFor` and `isMember` are required: a capability that reaches a
 * store is resolved from that store's own rows, never from what the capability
 * says about itself.
 */
export interface DelegationIndex {
  /** The session that spawned this one, if it was spawned by another session.
   *  Read with `spawnedByParentSessionId` — the one reader of the `spawnedBy`
   *  tag (POD-1133); nothing here matches the string itself. */
  parentSessionOf(sessionId: SessionId): SessionId | undefined
  /** The human a root agent session in this store was spawned for. `undefined`
   *  when this store holds no such session or it has no owner: the agent is
   *  then refused, never given the on-behalf-of its capability names. */
  onBehalfOfFor(sessionId: SessionId): UserId | undefined
  /** Is `user` a member of this store's workspace who can act (a row that is
   *  not disabled)? */
  isMember(user: UserId): boolean
}

/** Chain depth ceiling. A cycle in `spawnedBy` would otherwise hang the resolve;
 *  this is a fail-loud bound, not a policy about how deep agents may nest. */
const MAX_CHAIN_DEPTH = 64

/** {@link DelegationIndex} over durable state read asynchronously. */
export interface AsyncDelegationIndex {
  parentSessionOf(sessionId: SessionId): SessionId | undefined | Promise<SessionId | undefined>
  onBehalfOfFor(sessionId: SessionId): UserId | undefined | Promise<UserId | undefined>
  isMember(user: UserId): boolean | Promise<boolean>
}

/**
 * The refusal for a caller who is nobody in this workspace: a capability or
 * principal of another workspace, or a person who is not (or no longer) a
 * member here. The same FORBIDDEN a non-member gets, naming neither workspace.
 * A foreign workspace is a routing defect and is logged as one where it is
 * detected ({@link actsInOrReport}, {@link capabilityActsInOrReport}).
 */
export function foreignPrincipalRefusal(): TRPCError {
  return new TRPCError({ code: 'FORBIDDEN', message: 'not_workspace_member' })
}

/**
 * Does `capability` belong to `workspaceId`? Logged as a routing defect when
 * it does not: the edge stamps a capability with the workspace it bound the
 * call to, so a capability of another workspace reaching this store means a
 * call was routed to the wrong workspace's services.
 */
export function capabilityActsInOrReport(
  capability: Pick<Capability, 'workspaceId'>,
  workspaceId: WorkspaceId,
  where: string,
): boolean {
  if (capability.workspaceId === workspaceId) return true
  log.warn('a capability of another workspace reached this store', {
    where,
    capabilityWorkspace: capability.workspaceId,
    storeWorkspace: workspaceId,
  })
  return false
}

/**
 * Resolve the command principal for a call that arrived with `capability`, in
 * the store of `workspaceId` (POD-7558).
 *
 * Every refusal is answered like a non-member ({@link foreignPrincipalRefusal}),
 * whatever the path, so "your human cannot act here" has one answer:
 *  - the capability was issued in another workspace;
 *  - a capability that names no person (an unknown session's, or one whose
 *    human can no longer act);
 *  - a person who is not a member here (or is disabled);
 *  - an agent whose root session has no owner in this store, or whose owner is
 *    not a member here. The capability's own `onBehalfOf` is never used in its
 *    place: only this store's rows say whom an agent acts for.
 *
 * Today's two shapes map exactly onto D14's table: a capability with an
 * `actorSessionId` is the daemon-authenticated relay path (an agent), and one
 * without is the cookie/in-process operator channel (a human). Neither reads
 * anything from payload.
 */
export async function resolvePrincipalAsync(
  workspaceId: WorkspaceId,
  capability: Capability,
  delegations: AsyncDelegationIndex,
): Promise<CommandPrincipal> {
  if (!capabilityActsInOrReport(capability, workspaceId, 'resolve-principal')) {
    throw foreignPrincipalRefusal()
  }
  const actorSessionId = capability.actorSessionId
  if (actorSessionId === undefined) {
    const user = humanOf(capability)
    if (!(await delegations.isMember(user))) throw foreignPrincipalRefusal()
    return { kind: 'user', workspaceId, user, capability }
  }
  const chain: SessionId[] = []
  let cursor = await delegations.parentSessionOf(actorSessionId)
  while (cursor !== undefined && chain.length < MAX_CHAIN_DEPTH) {
    if (cursor === actorSessionId || chain.includes(cursor)) break
    chain.push(cursor)
    cursor = await delegations.parentSessionOf(cursor)
  }
  const root: SessionId = chain[chain.length - 1] ?? actorSessionId
  const onBehalfOf = await delegations.onBehalfOfFor(root)
  if (onBehalfOf === undefined) throw foreignPrincipalRefusal()
  if (!(await delegations.isMember(onBehalfOf))) throw foreignPrincipalRefusal()
  return agentPrincipal(workspaceId, capability, actorSessionId, onBehalfOf, chain)
}

/** {@link resolvePrincipalAsync} over an index that answers synchronously. */
export function resolvePrincipal(
  workspaceId: WorkspaceId,
  capability: Capability,
  delegations: DelegationIndex,
): CommandPrincipal {
  if (!capabilityActsInOrReport(capability, workspaceId, 'resolve-principal')) {
    throw foreignPrincipalRefusal()
  }
  const actorSessionId = capability.actorSessionId
  if (actorSessionId === undefined) {
    const user = humanOf(capability)
    if (!delegations.isMember(user)) throw foreignPrincipalRefusal()
    return { kind: 'user', workspaceId, user, capability }
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
  const onBehalfOf = delegations.onBehalfOfFor(root)
  if (onBehalfOf === undefined) throw foreignPrincipalRefusal()
  if (!delegations.isMember(onBehalfOf)) throw foreignPrincipalRefusal()
  return agentPrincipal(workspaceId, capability, actorSessionId, onBehalfOf, chain)
}

/**
 * The person a human capability names as both actor and on-behalf-of. A
 * capability that names nobody is refused like a non-member: it is what an
 * unknown session, or an agent whose human can no longer act, is minted as
 * (`capabilityForSession`).
 */
function humanOf(capability: Capability): UserId {
  const user = capability.onBehalfOf
  if (user === undefined || capability.actorUser !== user) throw foreignPrincipalRefusal()
  return user
}

function agentPrincipal(
  workspaceId: WorkspaceId,
  capability: Capability,
  agentSessionId: SessionId,
  onBehalfOf: UserId,
  chain: readonly SessionId[],
): AgentCommandPrincipal {
  return { kind: 'agent', workspaceId, agentSessionId, onBehalfOf, capability, chain }
}

/**
 * A system principal for a job over `workspaceId`'s store. Constructed
 * in-process only — it has no transport row.
 */
export function systemPrincipal(workspaceId: WorkspaceId, job: string): SystemCommandPrincipal {
  return { kind: 'system', workspaceId, job }
}

/** Does `principal` act in `workspaceId`? The one comparison every command makes. */
export function actsIn(principal: WorkspacePrincipal, workspaceId: WorkspaceId): boolean {
  if (principal.workspaceId !== workspaceId) return false
  // A user or agent principal also carries the capability it was resolved
  // from, which names the workspace it was issued in (POD-7558). Both must be
  // this one: a principal of this workspace holding another's capability was
  // put together wrongly somewhere, and is refused like a foreign one.
  return principal.capability === undefined || principal.capability.workspaceId === workspaceId
}

/** What {@link actsIn} reads of a principal. */
export interface WorkspacePrincipal {
  readonly workspaceId: WorkspaceId
  readonly capability?: Pick<Capability, 'workspaceId'>
}

/**
 * {@link actsIn}, reporting a mismatch as the defect it is. The edge binds a
 * request to one workspace and every principal is made there, so a principal
 * of another workspace reaching this store is a routing defect. It is logged
 * with the two workspace ids and nothing about the person, and the caller
 * refuses the command the way it refuses any caller who is not a member here
 * (a 403-class answer, never an internal error naming the other workspace).
 *
 * `where` names the check for the log: `front-door:trpc`, `trpc-context`,
 * `issue-dispatch`, `session-state`, `edge-member`.
 */
export function actsInOrReport(
  principal: WorkspacePrincipal,
  workspaceId: WorkspaceId,
  where: string,
): boolean {
  if (actsIn(principal, workspaceId)) return true
  log.warn('a principal of another workspace reached this store', {
    where,
    principalWorkspace: principal.workspaceId,
    capabilityWorkspace: principal.capability?.workspaceId,
    storeWorkspace: workspaceId,
  })
  return false
}
