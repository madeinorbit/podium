import { asAgentIdentityId, asCapabilityRef, asDelegationRef, asDeviceId, type Principal } from '@podium/protocol'
import type { CommandPrincipal } from '../command-principal'
export { negotiateContentCoding, syncResponseHeaders } from './content-coding'

/** Shared with tRPC: transport authentication supplies identity, never query fields. */
export function syncFeedPrincipal(principal: CommandPrincipal | undefined): Principal | undefined {
  if (principal?.kind === 'user') return {
    kind: 'user', user: principal.user,
    device: asDeviceId(`trpc:${principal.user}`),
    capability: asCapabilityRef(`trpc:user:${principal.user}`),
  }
  if (principal?.kind === 'agent') return {
    kind: 'agent', agentIdentity: asAgentIdentityId(principal.agentSessionId),
    onBehalfOf: principal.onBehalfOf,
    device: asDeviceId(`trpc:${principal.agentSessionId}`),
    capability: asCapabilityRef(`trpc:agent:${principal.agentSessionId}`),
    delegation: asDelegationRef(`session:${principal.agentSessionId}`),
  }
  return undefined
}
