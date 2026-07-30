/**
 * THE TRANSPORT→COMMAND SEAM — ADR 3 Amendment 1 D14 (principal from the
 * authenticated transport) meeting D17 (attribution is a pair).
 *
 * A `Capability` is what the command layer already consumes
 * (`authorize(cap, action, issue)`); a `Principal` is what the handshake resolves.
 * This is the ONE function that turns one into the other, so "where does the
 * command layer's identity come from?" has exactly one answer and it is a
 * transport principal.
 *
 * WHAT IT DOES NOT DO: decide rights. The scope handed in is resolved by the
 * policy layer at APPLY time (ADR 3 D8 / D16) — for an agent, by resolving its
 * delegation chain and intersecting with its human's CURRENT rights. Nothing here
 * caches, copies or freezes a scope, and there is no parameter that would let a
 * caller pass one in from a frame.
 *
 * ON-BEHALF-OF TODAY: a machine and a system job have none, and that is final
 * (D21.2). A human's and an agent's on-behalf-of needs a `UserId`, which arrives
 * with POD-1075 (accounts) and POD-323 (`SessionBinding` as the delegation
 * lifecycle). The pair is carried and tested here so that landing those is filling
 * a field, not adding a mechanism.
 */

import type { Principal } from '@podium/protocol'
import type { Capability, IssueRole, IssueScope } from '@podium/model'

export interface CapabilityRequest {
  /** The role floor the policy layer minted for this principal (ADR 3 Am.1 D15). */
  readonly role: IssueRole
  /** Resolved live by the policy layer; never taken from a frame. */
  readonly scope: IssueScope
}

/**
 * Stamp a command-layer capability from a transport principal. Both halves of the
 * attribution pair come from the principal — the actor from what performed the
 * call, the on-behalf-of from the human it was performed for.
 */
export const capabilityFromPrincipal = (
  principal: Principal,
  request: CapabilityRequest,
): Capability => {
  const base = { role: request.role, scope: request.scope }
  switch (principal.kind) {
    case 'user':
      // D17.2: for a human, actor and on-behalf-of are the same person, and the
      // pair is STILL recorded as a pair so consumers never branch on shape.
      return { ...base, actorUser: principal.user, onBehalfOf: principal.user }
    case 'agent':
      // The actor is the agent session (the existing `actorSessionId` seam); the
      // on-behalf-of is the human resolved from the delegation, never a payload.
      return {
        ...base,
        actorSessionId: principal.agentIdentity,
        onBehalfOf: principal.onBehalfOf,
      }
    case 'machine':
      // A machine is not a person. No on-behalf-of, not even a placeholder.
      return { ...base, actorUser: principal.machine }
    case 'system':
      // D21: a system job has no human and must never be assigned one.
      return { ...base, actorUser: principal.job }
  }
}
