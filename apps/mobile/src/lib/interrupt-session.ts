import type { SessionId } from '@podium/model'
import type { MobileTrpc } from '../client/trpc'

/** Deliver a stop request with the exact queued message selected by the controller. */
export async function interruptSession(
  sessions: Pick<MobileTrpc['sessions'], 'interrupt'>,
  sessionId: SessionId,
  messageId?: string,
): Promise<void> {
  const result = await sessions.interrupt.mutate({
    sessionId,
    ...(messageId ? { messageId } : {}),
  })
  if (result?.ok === false) {
    throw new Error(result.reason ?? 'the agent refused the interrupt')
  }
}
