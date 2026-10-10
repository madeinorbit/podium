/** The existing messages.ledger request wire, beside the synced message record. */
import { z } from 'zod'
import { ThreadIdField } from '../ids/brands'
import { MessageDeliveryStatusOnWire } from './message-delivery'

export const MessageLedgerWire = z.object({
  id: z.string(), threadId: ThreadIdField, inReplyTo: z.string().nullable(),
  from: z.string(), to: z.string(), kind: z.string(), urgency: z.string(), lifecycle: z.string(),
  body: z.string(), createdAt: z.string(), deliveryStatus: MessageDeliveryStatusOnWire,
  queuePosition: z.number().optional(), ackedBy: z.string().nullable(),
  deliveredAt: z.string().nullable(), deliveredTo: z.string().nullable(), expiresAt: z.string().nullable(),
  clampedFrom: z.string().nullable(), hop: z.number(), readAt: z.string().nullable().optional(),
  deadLetteredAt: z.string().nullable().optional(), deliveryDeferredAt: z.string().nullable().optional(),
  deliveryDeferredReason: z.string().nullable().optional(),
})
export type MessageLedgerWire = z.infer<typeof MessageLedgerWire>
