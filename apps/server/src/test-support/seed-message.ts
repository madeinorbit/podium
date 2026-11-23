/**
 * Put a message row into the delivery status a fixture names, through the
 * repository's own moves (POD-4765). Every row enters `stored` — `addMessage`
 * refuses anything else — so a fixture that wants a confirmed or failed row gets
 * there the way production does, stamps included.
 */

import type { MessageDeliveryStatus } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import type { MessagesRepository } from '../store/messages'
import type { MessageRow } from '../store/types'

export async function seedMessage(
  messages: MessagesRepository,
  row: Omit<MessageRow, 'deliveryStatus'> & { deliveryStatus?: MessageDeliveryStatus },
): Promise<void> {
  const status = row.deliveryStatus ?? 'stored'
  await messages.addMessage(fixtureWriteScope(), { ...row, deliveryStatus: 'stored' })
  const at = row.deliveredAt ?? row.createdAt
  const outcome = await (async () => {
    switch (status) {
      case 'stored':
        return { kind: 'applied' as const }
      case 'dispatched':
        return await messages.markDispatched(
          fixtureWriteScope(),
          row.id,
          row.deliveredTo,
          row.injectedAt ?? at,
        )
      case 'typed':
        if (!row.deliveredTo) throw new Error(`seedMessage: typed ${row.id} needs deliveredTo`)
        return await messages.markTyped(
          fixtureWriteScope(),
          row.id,
          row.deliveredTo,
          row.injectedAt ?? at,
        )
      case 'confirmed': {
        const confirmed = await messages.markDelivered(
          fixtureWriteScope(),
          row.id,
          row.deliveredTo,
          at,
        )
        if (row.readAt) await messages.markRead(fixtureWriteScope(), row.id, null, row.readAt)
        return confirmed
      }
      case 'failed':
        return await messages.markDeadLetter(
          fixtureWriteScope(),
          row.id,
          row.deadLetteredAt ?? at,
          row.deliveryDeferredReason ?? undefined,
        )
      case 'cancelled':
        return await messages.markCancelled(fixtureWriteScope(), row.id)
      case 'expired':
        return await messages.expireObserved(fixtureWriteScope(), {
          id: row.id,
          createdAt: row.createdAt,
          lifecycle: row.lifecycle,
          expiresAt: row.expiresAt,
        })
      default:
        throw new Error(`seedMessage: no production move reaches ${status} yet`)
    }
  })()
  if (outcome.kind !== 'applied') {
    throw new Error(`seedMessage: ${row.id} did not reach ${status} (${JSON.stringify(outcome)})`)
  }
}
