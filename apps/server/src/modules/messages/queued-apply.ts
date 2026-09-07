import type { SessionId } from '@podium/model'
import type { MessageRow } from '../../store'
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
      bus: EventBus
      now(): string
    },
  ) {}

  async authorize(messageId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message) return { ok: false, reason: 'session no longer exists' }
    if (message.status !== 'queued') return { ok: false, reason: `message is ${message.status}` }
    return await this.deps.authorize(message)
  }

  async applied(messageId: string, sessionId: SessionId): Promise<void> {
    const completion: Promise<void> = this.deps.applied(messageId, sessionId)
    await completion
  }

  /** The push crossed into the CLI but the agent has not been seen to take it —
   *  short of `applied`, and the point after which nothing is retyped (POD-1242). */
  async injected(messageId: string, sessionId: SessionId): Promise<void> {
    const completion: Promise<void> = this.deps.injected(messageId, sessionId)
    await completion
  }

  async reject(messageId: string, reason: string): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message || message.status !== 'queued') return
    const at = this.deps.now()
    if (!await this.deps.messages.markDeadLetter(message.id, at)) return
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
        status: 'dead_letter',
        reason,
      },
    })
    this.deps.bus.emit('message.deadLettered', { messageId, reason })
  }
}

/** Retract a physical queued delivery; only a concurrent terminal transition is benign. */
export async function cancelInterruptedQueuedMessage(
  messages: Pick<MessageDeliveryService, 'cancel'>,
  messageId: string,
): Promise<void> {
  try {
    const cancellation: Promise<MessageRow> = messages.cancel(messageId)
    await cancellation
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'message is no longer queued') {
      throw error
    }
  }
}
