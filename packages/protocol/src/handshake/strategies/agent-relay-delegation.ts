/**
 * AGENT RELAY — delegation reference. ADR 3 Amendment 1 D14's `relay` rows.
 *
 * NOT a peer role. ADR 5 D2's roles are `console` | `machine` | reserved `node`;
 * the agent command relay is a separate ingress, and ADR 5 D7 forbids collapsing
 * peer auth into it or requiring relay credentials as a substitute for peer role
 * auth. It gets its own strategy key for exactly that reason.
 *
 * What authenticates it: a SERVER-MINTED DELEGATION REFERENCE, resolved live
 * through {@link DelegationDirectory} (ADR 3 Amendment 1 D14.3 / D16). The
 * reference is baked into the relay path by the daemon that already authenticated
 * as a machine; it is not a free string a caller may choose, and a forged one is
 * inert because it must resolve to a durable record.
 *
 * What it may then address: its own scope INTERSECTED with its human's current
 * rights, resolved at EVERY apply (D16.1). Nothing is copied into the connection:
 * the principal carries the delegation REFERENCE, and `mint.forDelegation` takes
 * only that reference — there is no parameter through which a scope could be
 * frozen at handshake time.
 *
 * What it is refused: an unknown, revoked or unresolvable chain; a chain with no
 * human at its root or with more than one human; a chain that widens; and a chain
 * whose root human is disabled or revoked — which is how revoking a person
 * transitively disables their unattended agents with no reaper to write.
 *
 * The agent's DEFAULT scope is what it was spawned for (readiness §3.1.3 A2); the
 * human is a ceiling, not the default grant. The superagent's broad scope is the
 * one exception and says so in the type
 * (`HumanCeilingScope.justification`). Lifecycle of the agent principal is
 * `SessionBinding` (POD-323, A5) — this module resolves, it does not own.
 */

import type { z } from 'zod'
import { asAgentIdentityId, asDelegationRef, asDeviceId } from '../../planes/principal'
import { type DelegationDirectory, resolveDelegationChain } from '../delegation-chain'
import type { DelegationRefCredential } from '../envelope'
import type { AuthInput, AuthOutcome, CapabilityMinter, PeerAuthStrategy } from './types'

type Credential = z.infer<typeof DelegationRefCredential>

export interface AgentRelayDeps {
  readonly delegations: DelegationDirectory
  readonly mint: Pick<CapabilityMinter, 'forDelegation'>
}

export const createAgentRelayStrategy = (deps: AgentRelayDeps): PeerAuthStrategy<Credential> => ({
  role: 'agent-relay',
  credentialKind: 'delegationRef',
  name: 'agent-relay-delegation',
  authenticate({ credential, transport }: AuthInput<Credential>): AuthOutcome {
    const ref = asDelegationRef(credential.ref)
    const resolution = resolveDelegationChain(ref, deps.delegations)
    if (!resolution.ok)
      return {
        ok: false,
        reason: 'auth-failed',
        // Server-side only. The peer learns nothing about WHY: "unknown ref" and
        // "your human was revoked" must look identical from outside.
        diagnostic: `delegation chain unresolvable: ${resolution.reason}`,
      }
    return {
      ok: true,
      principal: {
        kind: 'agent',
        // Both halves of the attribution pair come from the resolved record, not
        // from `hello.claims.agentIdentity` / `claims.onBehalfOf`.
        agentIdentity: asAgentIdentityId(resolution.leaf.agentIdentity),
        onBehalfOf: resolution.onBehalfOf,
        device: asDeviceId(transport.connectionId ?? resolution.leaf.agentIdentity),
        // A REFERENCE, not a copy of the resolved rights.
        capability: deps.mint.forDelegation(ref),
        delegation: ref,
      },
    }
  },
})
