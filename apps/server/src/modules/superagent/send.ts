import { actorAgent, asAgentIdentityId, type SessionId, type UserId } from '@podium/model'
import type { MessageDeliveryService } from '../messages/service'
import { SUPERAGENT_AGENT_IDENTITY } from '../messages/types'

/**
 * WHAT THE SUPERAGENT TYPES INTO A SESSION IS ITS MESSAGE (POD-4846).
 *
 * One row from `superagent`, on behalf of the thread's owner, delivered like
 * any mail: inside the envelope (the superagent is "you, automated", not you),
 * waking a parked session, followed by its delivery status. A failure found
 * later tells the operator (POD-4778); one found at send time is this call's
 * answer. With no thread owner known, the superagent speaks for the default
 * owner, as `send_to_agent` always has. `messageId` names a message with a fact behind it — a new session's
 * first message is its spawn prompt — so a repeat stores it once.
 */
export function superagentSender(
  messages: Pick<MessageDeliveryService, 'send'>,
  ownerUserId: UserId | undefined,
): (input: {
  sessionId: SessionId
  text: string
  messageId?: string
}) => Promise<{ ok: boolean; reason?: string }> {
  return async ({ sessionId, text, messageId }) => {
    const r = await messages.send(
      ownerUserId
        ? {
            kind: 'superagent',
            attribution: {
              actor: actorAgent(asAgentIdentityId(SUPERAGENT_AGENT_IDENTITY)),
              onBehalfOf: ownerUserId,
            },
            delegationRef: SUPERAGENT_AGENT_IDENTITY,
          }
        : { kind: 'superagent' },
      {
        ...(messageId ? { messageId } : {}),
        to: { kind: 'session', id: sessionId },
        kind: 'message',
        urgency: 'next-turn',
        lifecycle: 'wake',
        body: text,
      },
    )
    // Stored is accepted: a push the transport refused is the sweep's to retry.
    return r.disposition === 'dead_letter'
      ? { ok: false, ...(r.reason ? { reason: r.reason } : {}) }
      : { ok: true }
  }
}
