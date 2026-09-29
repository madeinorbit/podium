import {
  isMessagePending,
  MessageDelivery,
  type SessionId,
  type TranscriptItemRef,
} from '@podium/model'
import type { QueueDrainAbandonedReason } from '@podium/protocol/daemon'
import type { MessageRow } from '../../store'
import { moved } from '../../store/messages'
import type { EventBus } from '../bus'
import type { MessageDeliveryDeps, MessageDeliveryService } from './service'

/** Durable apply-time guard shared by the session inbox and message delivery. */
export class QueuedMessageApply {
  constructor(
    private readonly deps: {
      messages: MessageDeliveryDeps['messages']
      events: MessageDeliveryDeps['events']
      authorize(
        message: MessageRow,
      ):
        | { ok: true }
        | { ok: false; reason: string }
        | Promise<{ ok: true } | { ok: false; reason: string }>
      applied(messageId: string, sessionId: SessionId): Promise<void>
      injected(messageId: string, sessionId: SessionId): Promise<void>
      unconfirmed(messageId: string, sessionId: SessionId, reason: string): Promise<void>
      bus: EventBus
      now(): string
    },
  ) {}

  async authorize(messageId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message) return { ok: false, reason: 'session no longer exists' }
    // Typing it must still be a move the lifecycle allows: not ended, not
    // already typed. An `unknown` row is the one exception: it was forwarded
    // and its answer lost, so the next forward is a RECOVERY the daemon answers
    // by id without retyping (POD-4775) — refusing it here would dead-letter a
    // message that may well have arrived.
    if (
      message.deliveryStatus !== 'unknown' &&
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

  /** The agent's machine named the entry in its history this message became
   *  (POD-4774): a first-writer-wins stamp, independent of the status. */
  async named(messageId: string, sessionId: SessionId, item: TranscriptItemRef): Promise<void> {
    await this.deps.messages.nameTranscriptItem(messageId, sessionId, item)
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

  async reject(
    messageId: string,
    reason: string,
    knownCause?: QueueDrainAbandonedReason,
  ): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message || !isMessagePending(message.deliveryStatus)) return
    const at = this.deps.now()
    // A HANDED-ON ROW IS NOT A VANISHED TARGET [POD-4704]. The
    // inbox settles a forwarded row as failed when the daemon never confirmed
    // it — typed but cut off mid-turn, never applied — and lands here, as does
    // a drain-time refusal of a row already queued behind it. Without a cause
    // the ledger falls back to "target gone" about a session that is alive
    // (POD-4604 run 13), so stamp `delivery-failed`: the delivery is what
    // failed, not the target. Rows never pushed keep no cause, and downstream
    // readers correctly read those as a vanished target.
    // A cause the daemon named wins: `never-live` says the agent was not
    // accepting input, which is exactly what the sender should read (POD-4775).
    const cause =
      knownCause ?? (message.deliveryStatus !== 'stored' ? 'delivery-failed' : undefined)
    if (!moved(await this.deps.messages.markDeadLetter(message.id, at, cause))) return
    await this.deps.events.appendEvent({
      ts: at,
      kind: 'message.dead_letter',
      subject: message.id,
      payload: {
        messageId: message.id,
        threadId: message.threadId,
        fromKind: message.fromKind,
        toKind: message.toKind,
        ...(message.toId ? { toId: message.toId } : {}),
        deliveryStatus: 'failed',
        reason,
      },
    })
    this.deps.bus.emit('message.deadLettered', { messageId, reason })
  }
}
