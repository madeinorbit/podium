/**
 * A CHAT MESSAGE RECORD ON THE FEED (POD-4764, POD-4720 §6.2).
 *
 * A message a person sent into a session, as every device sees it: the id the
 * sender minted, the text, where its delivery stands, and — once the agent's
 * machine named it — the entry it became in the agent's own history. The chat
 * shows the sender's outbox entry until this record arrives, then the record,
 * and drops it when the history entry with `transcriptItem.id` is on screen.
 * Nothing matches a message to its history by text.
 *
 * What the feed carries is not the whole history (the transcript is that): a
 * message on its way, one that failed or was lost track of until its sender
 * dismisses it, and a bounded window of the most recently confirmed ones, so a
 * device learns which history entry each became. The server keeps every row.
 */

import { z } from 'zod'
import { SessionIdField } from '../ids/brands'
import { type MessageDeliveryStatus, MessageDeliveryStatusOnWire } from './message-delivery'
import { TranscriptItemRef } from './transcript'

/** What a bubble shows of one attachment. The stored reference (with its path
 *  on the agent's machine) stays on the server. */
export const MessageRecordAttachment = z.object({
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  kind: z.enum(['image', 'file']),
})
export type MessageRecordAttachment = z.infer<typeof MessageRecordAttachment>

export const MessageRecordWire = z.object({
  /** The id the sender minted; the outbox entry that sent it carries the same. */
  id: z.string().min(1),
  /** The session it was sent to. */
  sessionId: SessionIdField,
  /** The user who sent it. */
  senderUserId: z.string().min(1),
  body: z.string(),
  attachments: z.array(MessageRecordAttachment).optional(),
  createdAt: z.string(),
  /** Where its delivery stands. Read tolerantly (POD-4885): a status a newer
   *  server added reads as still on its way, so this build keeps the row
   *  instead of refusing it and fetching it again forever. */
  status: MessageDeliveryStatusOnWire,
  /** Why a failed message will not be delivered, when the server knows. */
  reason: z.string().optional(),
  /** The entry it became in the agent's history, once the machine named it. */
  transcriptItem: TranscriptItemRef.optional(),
  /** When its sender asked to retract it (POD-4776). Beside `cancelled` the
   *  retract won; beside a pending status it is still on its way to the agent's
   *  machine; beside `typing`/`typed`/`accepted`/`confirmed` it came too late. */
  retractRequestedAt: z.string().optional(),
  /** When its sender dismissed its notice. The feed lets a dismissed message
   *  go, so only a read by id (`mail.records`, POD-4811) ever carries it. */
  noticeDismissedAt: z.string().optional(),
})
export type MessageRecordWire = z.infer<typeof MessageRecordWire>

/** Needs the sender's attention: it will not arrive (`failed`, `expired`), or
 *  nobody can say whether it did (`unknown`). Carried until dismissed. */
export const isMessageRecordAttention = (status: MessageDeliveryStatus): boolean =>
  status === 'failed' || status === 'expired' || status === 'unknown'
