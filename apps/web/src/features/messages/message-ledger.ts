import type { ThreadId } from '@podium/model'
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
  status: string
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
 * without manufacturing a complete ledger row. */
export function deadLetterDeliveryLine(reason: string | null | undefined): string {
  if (reason === 'never-live') return 'not delivered · session never became ready'
  if (reason === 'teardown') return 'not delivered · session torn down'
  if (reason === 'delivery-failed') return 'not delivered · delivery failed'
  return 'dead-lettered · target gone'
}

/** Chip tone for a delivery status: queued = pending amber; delivered/read = ok
 *  (the agent has it, pushed or pulled [POD-834]); expired/cancelled/dead_letter
 *  = dead. */
export function ledgerStatusTone(status: string): LedgerStatusTone {
  if (status === 'delivered' || status === 'read') return 'ok'
  if (status === 'queued') return 'queued'
  return 'dead'
}

/** One-line delivery story: "delivered to s1 · acked" / "read by s1" /
 *  "queued (expires …)" / "dead-lettered" / "expired undelivered" [POD-834]. */
export function deliveryLine(m: LedgerMessage): string {
  if (m.status === 'delivered') {
    const to = m.deliveredTo ? ` to ${m.deliveredTo}` : ''
    return `delivered${to}${m.ackedBy ? ` · acked by ${m.ackedBy}` : ''}`
  }
  if (m.status === 'read') {
    const to = m.deliveredTo ? ` by ${m.deliveredTo}` : ''
    return `read${to}${m.ackedBy ? ` · acked by ${m.ackedBy}` : ''}`
  }
  if (m.status === 'queued') {
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
  if (m.status === 'dead_letter') return deadLetterDeliveryLine(m.deliveryDeferredReason)
  if (m.status === 'expired') return 'expired undelivered'
  return m.status
}
