import type { SessionId } from '@podium/model'
import type { Conversation } from './model'

export const DESKTOP_WARM_CONVERSATIONS = 3
export const PHONE_WARM_CONVERSATIONS = 2

export interface ConversationCacheOptions {
  create: (sessionId: SessionId) => Conversation
  warmLimit?: number
}

interface Entry {
  conversation: Conversation
  refs: number
}

/** Principal-scoped, ref-counted ownership of live and warm conversations. */
export class ConversationCache {
  private readonly entries = new Map<SessionId, Entry>()
  private readonly warm = new Set<SessionId>()
  private trimScheduled = false
  private disposed = false

  constructor(private readonly options: ConversationCacheOptions) {}

  acquire(sessionId: SessionId): { conversation: Conversation; release: () => void } {
    if (this.disposed) throw new Error('The conversation owner has been disposed')
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = { conversation: this.options.create(sessionId), refs: 0 }
      this.entries.set(sessionId, entry)
      void entry.conversation.start()
    }
    this.warm.delete(sessionId)
    entry.refs++
    const held = entry
    let released = false
    return {
      conversation: held.conversation,
      release: () => {
        if (released || this.disposed) return
        released = true
        if (--held.refs !== 0) return
        this.warm.delete(sessionId)
        this.warm.add(sessionId)
        // Cleanup followed by setup in StrictMode can reacquire before eviction.
        // release itself never destroys the object or tears down the stream.
        if (this.trimScheduled) return
        this.trimScheduled = true
        queueMicrotask(() => {
          this.trimScheduled = false
          if (this.disposed) return
          const limit = Math.max(0, this.options.warmLimit ?? DESKTOP_WARM_CONVERSATIONS)
          while (this.warm.size > limit) {
            const oldest = this.warm.values().next().value!
            this.warm.delete(oldest)
            const evicted = this.entries.get(oldest)
            this.entries.delete(oldest)
            evicted?.conversation.dispose()
          }
        })
      },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const { conversation } of this.entries.values()) conversation.dispose()
    this.entries.clear()
    this.warm.clear()
  }
}
