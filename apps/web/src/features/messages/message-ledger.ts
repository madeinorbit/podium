import {
  deadLetterDeliveryLine,
  isMessageOnItsWay,
  isMessagePending,
  type MessageDeliveryStatus,
  type ThreadId,
} from '@podium/model'
/**
 * Message-ledger view model (#237) [spec:SP-34d7 web]: pure helpers over the
 * `messages.ledger` wire — the anti-"mail broke down mysteriously" surface.
 * The human must be able to answer "what happened to my message / why didn't
 * my wake fire" from these derivations alone.
 */

/** The `messages.ledger` wire row (MessageWire on the server gate). */
export interface LedgerMessage {
  id: string
  threadId: ThreadId
  inReplyTo: string | null
  from: string
  to: string
  kind: string
  urgency: string
  lifecycle: string
  body: string
  createdAt: string
  /** Legacy vocabulary, kept on the wire for older clients; not read here. */
  status: string
  /** Where delivery stands, forward-only (`MessageDelivery` in @podium/model). */
  deliveryStatus: MessageDeliveryStatus
  /** Current 1-based position in the recipient session FIFO at read time. */
  queuePosition?: number
  ackedBy: string | null
  deliveredAt: string | null
  deliveredTo: string | null
  expiresAt: string | null
  clampedFrom: string | null
  hop: number
  // Message-lifecycle timestamps (#834 [POD-834 §04d]).
  readAt?: string | null
  deadLetteredAt?: string | null
  deliveryDeferredAt?: string | null
  deliveryDeferredReason?: string | null
}

export interface ClampSummary {
  /** e.g. "interrupt → next-turn" / "wake → wait" (only downgraded axes). */
  parts: string[]
  reasons: string[]
}

/** Requested-vs-effective axes when the clamp matrix downgraded a send.
 *  Null when the message went out exactly as requested. */
export function clampSummary(m: LedgerMessage): ClampSummary | null {
  if (!m.clampedFrom) return null
  let requested: { urgency?: string; lifecycle?: string; reasons?: string[] }
  try {
    requested = JSON.parse(m.clampedFrom) as typeof requested
  } catch {
    return { parts: ['clamped'], reasons: [] }
  }
  const parts: string[] = []
  if (requested.urgency && requested.urgency !== m.urgency)
    parts.push(`${requested.urgency} → ${m.urgency}`)
  if (requested.lifecycle && requested.lifecycle !== m.lifecycle)
    parts.push(`${requested.lifecycle} → ${m.lifecycle}`)
  if (parts.length === 0) parts.push('clamped')
  return { parts, reasons: requested.reasons ?? [] }
}

export type LedgerStatusTone = 'queued' | 'ok' | 'dead'

/** Why a terminal chat delivery never reached its session. Kept separate from
 * {@link deliveryLine} so the chat transcript can render the same explanation
 * without manufacturing a complete ledger row. One shared wording [POD-4704]:
 * an injected-but-unconfirmed dead letter (delivery-failed) is a delivery
 * failure, never a vanished target. */
export { deadLetterDeliveryLine }

/** Chip tone for a delivery status: still pending (held, on its way, or lost
 *  track of) = amber; confirmed = ok (the agent has it, pushed or pulled
 *  [POD-834]); failed/expired/cancelled = dead. */
export function ledgerStatusTone(status: MessageDeliveryStatus): LedgerStatusTone {
  if (status === 'confirmed') return 'ok'
  if (isMessagePending(status)) return 'queued'
  return 'dead'
}

/** One-line delivery story: "delivered to s1 · acked" / "read by s1" /
 *  "queued (expires …)" / "handed to s1" / "dead-lettered" / "expired
 *  undelivered" [POD-834]. */
export function deliveryLine(m: LedgerMessage): string {
  const acked = m.ackedBy ? ` · acked by ${m.ackedBy}` : ''
  if (m.deliveryStatus === 'confirmed' && m.readAt) {
    const to = m.deliveredTo ? ` by ${m.deliveredTo}` : ''
    return `read${to}${acked}`
  }
  if (m.deliveryStatus === 'confirmed') {
    const to = m.deliveredTo ? ` to ${m.deliveredTo}` : ''
    return `delivered${to}${acked}`
  }
  if (m.deliveryStatus === 'unknown') return 'not confirmed · it may or may not have arrived'
  if (isMessageOnItsWay(m.deliveryStatus)) {
    const to = m.deliveredTo ? ` to ${m.deliveredTo}` : ''
    const stage = m.deliveryStatus === 'typed' ? 'typed' : 'handed on'
    return `${stage}${to} · not yet confirmed`
  }
  if (m.deliveryStatus === 'stored') {
    const position =
      typeof m.queuePosition === 'number' &&
      Number.isInteger(m.queuePosition) &&
      m.queuePosition > 0
        ? ` · queue position ${m.queuePosition}`
        : ''
    return `${m.expiresAt ? `queued · expires ${m.expiresAt}` : 'queued'}${position}`
  }
  // A dead letter says WHY when the daemon told us why [POD-2132, POD-2202]: the
  // drain gave up, so this row is terminal rather than waiting on anything.
  if (m.deliveryStatus === 'failed') return deadLetterDeliveryLine(m.deliveryDeferredReason)
  if (m.deliveryStatus === 'expired') return 'expired undelivered'
  return m.deliveryStatus
}
