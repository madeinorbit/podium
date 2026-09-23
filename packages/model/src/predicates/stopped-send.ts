/**
 * "Was this send stopped before it reached the server?" (POD-4654).
 *
 * A Stop may arrive before the send it stops: the phone queues its sends and
 * sends its Stop straight away. The server then reserves the send's id, and the
 * late send replays this refusal instead of starting the stopped work. For the
 * client that reply is the Stop taking effect — nothing to deliver, nothing to
 * recover — unlike every other refused send, whose words must stay recoverable.
 * One literal for both sides, so the server's reply and the client's reading of
 * it cannot drift apart.
 */
export const STOPPED_SEND_REASON = 'interaction interrupted'

/** True for exactly the server's reply to a send whose Stop arrived first. */
export function isStoppedSend(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { ok?: unknown }).ok === false &&
    (result as { reason?: unknown }).reason === STOPPED_SEND_REASON
  )
}
