/**
 * WHERE A PHONE SEND GOES.
 *
 * Every send goes through the durable outbox, live or parked, online or not
 * (POD-4762) — the one mechanism that keeps a message on the phone, retries it
 * under its own id and gives up with "not sent". What remains to decide per send
 * is only which command carries it:
 *
 * - `send`: the session takes text (`sessions.sendText`), or is parked but
 *   recoverable and the send wakes it first (`wake`, `sessions.resumeAndSend`).
 * - `refused`: the composer itself says the session cannot take text. Failing
 *   here, with the composer's own reason, instead of queueing a send the
 *   server would refuse.
 *
 * Connectivity is deliberately NOT an input any more: an offline tap is the
 * same send, held by the outbox until it can go or gives up.
 */

export type ChatSendTransport =
  | { readonly kind: 'send'; readonly wake: boolean }
  | { readonly kind: 'refused'; readonly reason: string }

export function chatSendTransport(input: {
  /** The session takes text straight through (live or starting). */
  sendable: boolean
  /** Parked but recoverable — submitting wakes it and the text is delivered. */
  canResume: boolean
  /** Server refusal copy for a session that takes no text, when there is one. */
  refusalReason?: string
}): ChatSendTransport {
  if (input.sendable) return { kind: 'send', wake: false }
  if (input.canResume) return { kind: 'send', wake: true }
  return { kind: 'refused', reason: input.refusalReason ?? 'Session is not running.' }
}
