import type { SessionId } from '@podium/model'
import { useLayoutEffect, useRef, useState } from 'react'
import { Conversation, type ConversationOptions } from '../conversation/model'
import type { DraftStore } from '../conversation/draft-store'
import { useStoreHandle } from './provider'

const factories = new WeakMap<object, Map<SessionId, () => Conversation>>()

/** A single principal owns live conversations and the bounded warm cache. */
export function useConversation<T extends Conversation = Conversation>(
  sessionId: SessionId | undefined,
  createOptions: (drafts: DraftStore) => ConversationOptions | T,
  options: { warmLimit?: number; enabled?: boolean } = {},
): T | undefined {
  const owner = useStoreHandle()
  const create = useRef(createOptions)
  const [held, setHeld] = useState<{ owner: typeof owner; id: SessionId; conversation: Conversation }>()
  useLayoutEffect(() => { create.current = createOptions }, [createOptions])
  const enabled = options.enabled !== false
  useLayoutEffect(() => {
    if (!enabled || sessionId === undefined) return
    let byId = factories.get(owner)
    if (!byId) factories.set(owner, byId = new Map())
    const factory = () => {
      const value = create.current(owner.drafts)
      return value instanceof Conversation ? value : new Conversation(value)
    }
    byId.set(sessionId, factory)
    const registered = byId
    const cache = owner.ownConversations({
      warmLimit: options.warmLimit,
      create: id => {
        const factory = registered.get(id)
        if (!factory) throw new Error(`No conversation host for ${id}`)
        return factory()
      },
    })
    const lease = cache.acquire(sessionId)
    setHeld({ owner, id: sessionId, conversation: lease.conversation })
    return () => {
      lease.release()
      if (registered.get(sessionId) === factory) registered.delete(sessionId)
    }
  }, [owner, sessionId, enabled, options.warmLimit])
  return enabled && held?.owner === owner && held.id === sessionId ? held.conversation as T : undefined
}
