import type { SessionId } from '@podium/model'
import type { MessageRow } from '../../store'
import type { EventBus } from '../bus'
import type { MessageDeliveryDeps } from './service'

/** Durable apply-time guard shared by the session inbox and message delivery. */
export class QueuedMessageApply {
  constructor(
    private readonly deps: {
      messages: MessageDeliveryDeps['messages']
      events: MessageDeliveryDeps['events']
      authorize(message: MessageRow): { ok: true } | { ok: false; reason: string }
      applied(messageId: string, sessionId: SessionId): void
      injected(messageId: string, sessionId: SessionId): void
      bus: EventBus
      now(): string
    },
  ) {}

  async authorize(messageId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message) return { ok: false, reason: 'session no longer exists' }
    if (message.status !== 'queued') return { ok: false, reason: `message is ${message.status}` }
    return this.deps.authorize(message)
  }

  applied(messageId: string, sessionId: SessionId): void {
    this.deps.applied(messageId, sessionId)
  }

  /** The push crossed into the CLI but the agent has not been seen to take it —
   *  short of `applied`, and the point after which nothing is retyped (POD-1242). */
  injected(messageId: string, sessionId: SessionId): void {
    this.deps.injected(messageId, sessionId)
  }

  async reject(messageId: string, reason: string): Promise<void> {
    const message = await this.deps.messages.getMessage(messageId)
    if (!message || message.status !== 'queued') return
    const at = this.deps.now()
    if (!await this.deps.messages.markDeadLetter(message.id, at)) return
    try {
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
    } catch {}
    this.deps.bus.emit('message.deadLettered', { messageId, reason })
  }
}
