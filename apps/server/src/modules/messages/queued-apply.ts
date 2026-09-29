import {
  type HarnessRef,
  MessageDelivery,
  type MessageDeliveryStatus,
  type MessageHeld,
  type SessionId,
  type TranscriptItemRef,
} from '@podium/model'
import type { QueueDrainAbandonedReason } from '@podium/protocol/daemon'
import type { MessageRow } from '../../store'
import type { MessageDeliveryDeps } from './service'

/** Statuses whose row the daemon already had: forwarding one again is a
 *  recovery it answers by id, never a second typing. */
const FORWARDED_AGAIN_AS_RECOVERY: ReadonlySet<MessageDeliveryStatus> = new Set([
  'unknown',
  'accepted',
])

/** Durable apply-time guard shared by the session inbox and message delivery. */
export class QueuedMessageApply {
  constructor(
    private readonly deps: {
      messages: MessageDeliveryDeps['messages']
      authorize(
        message: MessageRow,
      ):
        | { ok: true }
        | { ok: false; reason: string }
        | Promise<{ ok: true } | { ok: false; reason: string }>
      applied(messageId: string, sessionId: SessionId): Promise<void>
      injected(messageId: string, sessionId: SessionId): Promise<void>
      unconfirmed(messageId: string, sessionId: SessionId, reason: string): Promise<void>
      rejected(messageId: string, reason: string, cause?: QueueDrainAbandonedReason): Promise<void>
    },
  ) {}

  async authorize(messageId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message) return { ok: false, reason: 'session no longer exists' }
    // Typing it must still be a move the lifecycle allows: not ended, not
    // already typed. Two exceptions, both rows the daemon was already given:
    // `unknown` (forwarded, its answer lost) and `accepted` (the agent program
    // holds it, not yet in its history — POD-4885). Their next forward is a
    // RECOVERY the daemon answers by id without retyping (POD-4775); refusing
    // it here would dead-letter a message that arrived, or may well have.
    if (
      !FORWARDED_AGAIN_AS_RECOVERY.has(message.deliveryStatus) &&
      !MessageDelivery.canMove(message.deliveryStatus, 'typed')
    ) {
      return { ok: false, reason: `message is ${message.deliveryStatus}` }
    }
    return await this.deps.authorize(message)
  }

  async applied(messageId: string, sessionId: SessionId): Promise<void> {
    const completion: Promise<void> = this.deps.applied(messageId, sessionId)
    await completion
  }

  /** How the agent program holds this message, as its machine last reported
   *  (POD-4886): kept after the status moves on. */
  async held(messageId: string): Promise<MessageHeld | undefined> {
    return (await this.deps.messages.getMessage(messageId))?.held
  }

  /** The agent's machine named the entry in its history this message became
   *  (POD-4774): a first-writer-wins stamp, independent of the status. */
  async named(messageId: string, sessionId: SessionId, item: TranscriptItemRef): Promise<void> {
    await this.deps.messages.nameTranscriptItem(messageId, sessionId, item)
  }

  /** The agent's machine reported the program's own ids for this message
   *  (POD-4841): added to those already kept, independent of the status. */
  async harnessIds(messageId: string, sessionId: SessionId, harnessRef: HarnessRef): Promise<void> {
    await this.deps.messages.recordHarnessRef(messageId, sessionId, harnessRef)
  }

  /** The push crossed into the CLI but the agent has not been seen to take it —
   *  short of `applied`, and the point after which nothing is retyped (POD-1242). */
  async injected(messageId: string, sessionId: SessionId): Promise<void> {
    const completion: Promise<void> = this.deps.injected(messageId, sessionId)
    await completion
  }

  /** The row's fate is lost: a forward timed out, or the daemon could not prove
   *  the text landed. `unknown`, never failed (POD-4775). */
  async unconfirmed(messageId: string, sessionId: SessionId, reason: string): Promise<void> {
    const completion: Promise<void> = this.deps.unconfirmed(messageId, sessionId, reason)
    await completion
  }

  /** The inbox refused the row at apply time (no `cause`), or the daemon said
   *  it was never typed (`cause`): the message fails and its sender is told,
   *  in one write (POD-4778). */
  async reject(
    messageId: string,
    reason: string,
    knownCause?: QueueDrainAbandonedReason,
  ): Promise<void> {
    const completion: Promise<void> = this.deps.rejected(messageId, reason, knownCause)
    await completion
  }
}
