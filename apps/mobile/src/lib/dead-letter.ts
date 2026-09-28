/**
 * Dead-lettered operator messages for the phone [POD-4704].
 *
 * Mirrors the web chat's `deadLetteredOperatorMessages`: a delivery the
 * authority gave up on is terminal, so it is not in the queued projection the
 * conversation controller keeps — but dropping it off the surface is what made
 * a failed send look like a send that never happened. The wording is the one
 * shared helper every surface uses, so an injected-but-unconfirmed row
 * (delivery-failed) reads as delivery failed, never as a vanished target,
 * while a causeless row still reads as target gone.
 */
import { deadLetterDeliveryLine } from '@podium/model'

export interface DeadLetteredChatMessage {
  id: string
  text: string
  at: number
  failure: string
}

export function deadLetteredOperatorMessages(
  rows: unknown,
  sessionId: string,
): DeadLetteredChatMessage[] {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .filter(
      (row) =>
        row.from === 'operator' &&
        row.to === `session:${sessionId}` &&
        row.status === 'dead_letter' &&
        typeof row.id === 'string' &&
        typeof row.body === 'string' &&
        typeof row.createdAt === 'string',
    )
    .map((row) => ({
      id: row.id as string,
      text: row.body as string,
      at: Date.parse(row.createdAt as string) || 0,
      failure: deadLetterDeliveryLine(
        typeof row.deliveryDeferredReason === 'string' ? row.deliveryDeferredReason : null,
      ),
    }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
