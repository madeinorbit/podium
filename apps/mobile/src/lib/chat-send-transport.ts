/**
 * WHERE A PHONE SEND GOES (POD-4688).
 *
 * The desktop chat hands a live-session send to the server AT ONCE, with a
 * direct `sessions.sendText` mutate (`use-chat-send`'s `session` route). The
 * phone used to hand EVERY send — live or parked, online or offline — to the
 * durable outbox (`store.resumeAndSend`), so even a message to a running agent
 * waited behind the queue's store commits, drain scheduling and backoff. On a
 * busy session that read as "each send waits for the previous turn".
 *
 * The phone now makes the desktop's distinction, per send:
 *
 * - `direct`: online with a session that takes text straight through. One
 *   `sendText` mutate, issued in the tap's own async chain — nothing
 *   durable, nothing scheduled, nothing to wait out. The server still orders
 *   it behind its own durable queue when one exists, so two rapid taps land
 *   in order.
 * - `outbox`: the session is parked (wake path, unchanged), or the transport
 *   is down. Offline taps keep today's held behaviour — the message queues
 *   and goes out on reconnect — instead of failing in the operator's hand.
 * - `refused`: the composer itself says the session cannot take text. Failing
 *   here, with the composer's own reason, instead of queueing a send the
 *   server would dead-letter and park behind a recovery banner.
 */

export type ChatSendTransport =
  | { readonly kind: 'direct' }
  | { readonly kind: 'outbox' }
  | { readonly kind: 'refused'; readonly reason: string }

export function chatSendTransport(input: {
  /** The session takes text straight through (live or starting). */
  sendable: boolean
  /** Parked but recoverable — submitting wakes it and the text is delivered. */
  canResume: boolean
  /** Server refusal copy for a session that takes no text, when there is one. */
  refusalReason?: string
  /** The socket transport's liveness. Offline taps queue rather than fail. */
  connected: boolean
}): ChatSendTransport {
  if (input.sendable && input.connected) return { kind: 'direct' }
  if (input.sendable || input.canResume) return { kind: 'outbox' }
  return { kind: 'refused', reason: input.refusalReason ?? 'Session is not running.' }
}

/**
 * Read the desktop's handed-on shape off the mobile's sendText reply.
 *
 * The mobile tRPC seam types `sendText` without a response shape (the server
 * router type would pull the whole server into the Metro graph), so the
 * `queued` disposition and its FIFO position are read defensively rather than
 * destructured. Anything that is not a queued acceptance is a send that
 * crossed — the same two outcomes the desktop deliver maps to `queued` and
 * `sent`.
 */
export function queuedDeliveryOf(result: unknown): { state: 'queued'; position?: number } | null {
  if (typeof result !== 'object' || result === null || !('disposition' in result)) return null
  if ((result as { disposition?: unknown }).disposition !== 'queued') return null
  const position = (result as { position?: unknown }).position
  return { state: 'queued', ...(typeof position === 'number' ? { position } : {}) }
}
