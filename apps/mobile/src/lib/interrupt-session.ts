import type { SessionId } from '@podium/model'

/**
 * Stop the turn on screen (POD-6397): a `session.interrupt` effect record
 * naming that turn (`turnStartedAt` of the session's agent state) and the
 * queued message the controller selected. It resolves once the record is
 * durably queued; the session model shows Interrupting…, and Kill if the turn
 * runs on, from the record.
 */
export async function interruptSession(
  store: { interruptTurn(sessionId: SessionId, args: { turn?: string; messageId?: string }): Promise<string> },
  session: { readonly turnStartedAt?: string | undefined } | undefined,
  sessionId: SessionId,
  messageId?: string,
): Promise<void> {
  const turn = session?.turnStartedAt
  await store.interruptTurn(sessionId, {
    ...(turn !== undefined ? { turn } : {}),
    ...(messageId ? { messageId } : {}),
  })
}
