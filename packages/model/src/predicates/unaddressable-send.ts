/**
 * "Was this send refused because its session no longer exists?" (POD-4660).
 *
 * The phone queues its sends, so one can reach the server after its session
 * was deleted. The server answers it with this dead-letter, and for the client
 * there is nothing to recover: no session is left to deliver it to, and a retry
 * can only get the same answer. Parked like any other refused send, it would
 * hold every later send queued for that session. One literal for both sides, so
 * the server's reply and the client's reading of it cannot drift apart.
 *
 * The server gives the same answer for a session the principal cannot see, so
 * reading it reveals nothing the reply did not already say.
 */
export const UNADDRESSABLE_SEND_REASON = 'dead-lettered: session no longer exists'

/** True for exactly the server's reply to a send whose session is gone. */
export function isUnaddressableSend(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { ok?: unknown }).ok === false &&
    (result as { reason?: unknown }).reason === UNADDRESSABLE_SEND_REASON
  )
}
