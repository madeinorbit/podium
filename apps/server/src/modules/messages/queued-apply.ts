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
      bus: EventBus
      now(): string
    },
  ) {}

  authorize(messageId: string): { ok: true } | { ok: false; reason: string } {
    const message = this.deps.messages.getMessage(messageId)
    if (!message) return { ok: false, reason: 'session no longer exists' }
    return this.deps.authorize(message)
  }

  reject(messageId: string, reason: string): void {
    const message = this.deps.messages.getMessage(messageId)
    if (!message || message.status !== 'queued') return
    const at = this.deps.now()
    if (!this.deps.messages.markDeadLetter(message.id, at)) return
    try {
      this.deps.events.appendEvent({
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
