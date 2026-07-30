import { z } from 'zod'
import type { MachineId } from '../ids'

/**
 * The transport-derived principal that every plane port carries on its
 * DELIVERY path — ADR 3 D7 (principal from the authenticated transport only;
 * payload identity is inert) as extended by ADR 3 Amendment 1 D14 (the
 * principal is `(user, device, capability)`, with an agent variant carrying
 * `agentIdentity`, `onBehalfOf` and a server-minted delegation reference).
 *
 * WHY THE PORTS CARRY IT: a port that cannot express "delivered to THIS
 * principal" cannot express the scoped feed (ADR 2 Amendment 1 D12) or an
 * identity-carrying presence record (ADR 7 Amendment 1 D9). That is the
 * failure mode designed out here.
 *
 * WHAT THE PORTS MUST NOT DO: evaluate policy. Authorization stays with the
 * command layer and ADR 3 D8's apply-time re-authorization. The ports never
 * inspect `capability`; they treat it as an opaque server-minted reference and
 * consult a {@link VisibilityResolver} owned by the policy layer when a
 * routing decision needs one (ADR 7 Amendment 1 D14). Nothing in this file
 * decides who may see what.
 *
 * BRANDS: `UserId` / `DeviceId` / `AgentIdentityId` are defined here because
 * no user identity exists in the model yet. ADR 4 Amendment 1 D9.1 owns
 * `UserId`'s shape and Phase 1 (POD-299/POD-300) re-homes these brands to
 * `packages/model`; this module is their transitional home, matching
 * `ids.ts`'s additive-only posture.
 */

export const UserId = z.string().min(1).brand<'UserId'>()
export type UserId = z.infer<typeof UserId>
export const asUserId = (s: string): UserId => s as UserId

/** The authenticated client session / daemon binding a call arrived on. */
export const DeviceId = z.string().min(1).brand<'DeviceId'>()
export type DeviceId = z.infer<typeof DeviceId>
export const asDeviceId = (s: string): DeviceId => s as DeviceId

/** The agent session acting; the actor half of ADR 3 D17's attribution pair. */
export const AgentIdentityId = z.string().min(1).brand<'AgentIdentityId'>()
export type AgentIdentityId = z.infer<typeof AgentIdentityId>
export const asAgentIdentityId = (s: string): AgentIdentityId => s as AgentIdentityId

/**
 * Reference to the server-minted capability (today's role + scope, extended by
 * ADR 3 Amendment 1 D18/D19). OPAQUE to the ports: carried, never inspected.
 * Its shape is ADR 3's and is deliberately not restated here — a port that
 * could read a scope out of it would be a port that could evaluate policy.
 */
export const CapabilityRef = z.string().min(1).brand<'CapabilityRef'>()
export type CapabilityRef = z.infer<typeof CapabilityRef>
export const asCapabilityRef = (s: string): CapabilityRef => s as CapabilityRef

/** Reference to the durable delegation record (ADR 3 Amendment 1 D14.3/D16). */
export const DelegationRef = z.string().min(1).brand<'DelegationRef'>()
export type DelegationRef = z.infer<typeof DelegationRef>
export const asDelegationRef = (s: string): DelegationRef => s as DelegationRef

/** A person on `trpc` / the operator channels. */
export interface UserPrincipal {
  readonly kind: 'user'
  readonly user: UserId
  readonly device: DeviceId
  readonly capability: CapabilityRef
}

/**
 * An agent acting for a human. `onBehalfOf` is resolved from the delegation
 * reference, NEVER from a payload string (ADR 3 Amendment 1 D14.3).
 */
export interface AgentPrincipal {
  readonly kind: 'agent'
  readonly agentIdentity: AgentIdentityId
  readonly onBehalfOf: UserId
  readonly device: DeviceId
  readonly capability: CapabilityRef
  readonly delegation: DelegationRef
}

/** A paired machine on the `peer` transport. A machine is not a person. */
export interface MachinePrincipal
  extends Readonly<{
    kind: 'machine'
    machine: MachineId
    device: DeviceId
    capability: CapabilityRef
  }> {}

/**
 * An in-process system job (steward, expiry, boot reconcile). It has NO user
 * and is never assigned one (ADR 3 Amendment 1 D14.2/D21); it is unreachable
 * from any transport.
 */
export interface SystemPrincipal {
  readonly kind: 'system'
  readonly job: string
}

export type Principal = UserPrincipal | AgentPrincipal | MachinePrincipal | SystemPrincipal

/**
 * ADR 3 D17's attribution pair, projected off the principal. `onBehalfOf` is a
 * distinct representable "none" for machine and system principals — never
 * defaulted to an operator or to a row's owner.
 */
export interface Attribution {
  readonly actor: UserId | AgentIdentityId | MachineId | string
  readonly onBehalfOf: UserId | null
}

export const attributionOf = (p: Principal): Attribution => {
  switch (p.kind) {
    case 'user':
      // Same user in both halves — still recorded as a pair so consumers never
      // branch on shape (ADR 3 Amendment 1 D17.2).
      return { actor: p.user, onBehalfOf: p.user }
    case 'agent':
      return { actor: p.agentIdentity, onBehalfOf: p.onBehalfOf }
    case 'machine':
      return { actor: p.machine, onBehalfOf: null }
    case 'system':
      return { actor: p.job, onBehalfOf: null }
  }
}

/**
 * The routing identity of a principal: membership in a routing set is per
 * PRINCIPAL, not per connection (ADR 7 Amendment 1 D9.4 — two tabs are one
 * member with two connections). For an agent the identity is the agent itself,
 * not the human it acts for: "your agent is watching this session" must be
 * distinguishable from "you are".
 */
export const principalRoutingId = (p: Principal): string => {
  switch (p.kind) {
    case 'user':
      return `user:${p.user}`
    case 'agent':
      return `agent:${p.agentIdentity}`
    case 'machine':
      return `machine:${p.machine}`
    case 'system':
      return `system:${p.job}`
  }
}

/**
 * The policy layer's hook into routing. The ports CONSULT it (ADR 7
 * Amendment 1 D14: a room join is refused unless the principal may see the
 * entity) and never implement it. Default-closed is the resolver's obligation
 * under ADR 9 D4 — a port asks, and treats anything other than an explicit
 * `true` as "no".
 */
export interface VisibilityResolver {
  /**
   * May this principal see this entity? Refusal and nonexistence MUST be
   * indistinguishable to the caller (ADR 7 Amendment 1 D14.3), so this returns
   * a bare boolean: there is no reason code to leak.
   */
  canSee(principal: Principal, entity: { readonly kind: string; readonly id: string }): boolean
}
