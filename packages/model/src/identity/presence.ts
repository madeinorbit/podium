import { z } from 'zod'
import { AgentIdentityId, UserId } from '../ids'

/**
 * WHO — stamped by the server from the authenticated transport principal
 * (ADR 3 D7, D9.1). No inbound frame carries an identity field, so a spoofed
 * identity is unrepresentable rather than merely rejected. The agent variant
 * carries ADR 3 D17's attribution pair, so "your agent is watching this
 * session" needs no second identity concept.
 */
export const PresenceIdentity = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), user: UserId }),
  z.object({
    kind: z.literal('agent'),
    agentIdentity: AgentIdentityId,
    onBehalfOf: UserId,
  }),
])
export type PresenceIdentity = z.infer<typeof PresenceIdentity>
