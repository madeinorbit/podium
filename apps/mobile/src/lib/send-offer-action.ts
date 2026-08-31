import { assertSendAccepted } from '@podium/client-core/engine'
import { randomUUID } from '@podium/client-core/id'
import { asMutationId, type SessionId } from '@podium/model'
import type { MobileTrpc } from '../client/trpc'

/**
 * Send an offer answer as the live interaction it is.
 *
 * This deliberately bypasses the client outbox. Replaying an accepted action
 * after the operator has moved on is not safe, and enqueueing only proves that
 * the phone stored the answer — it does not reach `prepareInboxSend`, clear the
 * offer, or open a user turn. A parked session still needs the wake procedure,
 * but that procedure is invoked directly for the same fail-fast contract.
 */
export async function sendOfferAction(
  sessions: Pick<MobileTrpc['sessions'], 'sendText' | 'resumeAndSend'>,
  input: {
    sessionId: SessionId
    text: string
    wake: boolean
    mutationId?: ReturnType<typeof asMutationId>
  },
): Promise<void> {
  const mutation = input.wake ? sessions.resumeAndSend : sessions.sendText
  const result = await mutation.mutate({
    sessionId: input.sessionId,
    text: input.text,
    mutationId: input.mutationId ?? asMutationId(randomUUID()),
  })
  assertSendAccepted(result)
}
