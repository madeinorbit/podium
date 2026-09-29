/**
 * The conversation controller's two synced inputs, read from the engine store
 * (POD-4764): this session's message records, and the chat sends the outbox
 * still holds for it. Shared by web and mobile so both follow one rule.
 */

import type { MessageRecordWire, SessionId } from '@podium/model'
import type { OutboxChatSend } from '../engine/chat-send'
import type { ConversationOutbox, ConversationRecords } from './controller'

interface StoreSource<S> {
  getSnapshot(): S
  subscribe(listener: () => void): () => void
}

/** Notify only when `pick` of the store snapshot changes identity. */
function subscribeTo<S, V>(
  store: StoreSource<S>,
  pick: (snapshot: S) => V,
  listener: () => void,
): () => void {
  let last = pick(store.getSnapshot())
  return store.subscribe(() => {
    const next = pick(store.getSnapshot())
    if (next === last) return
    last = next
    listener()
  })
}

const NO_RECORDS: readonly MessageRecordWire[] = []

/** This session's records, recomputed only when the replicated set changes. */
export function storeConversationRecords(
  store: StoreSource<{ readonly messageRecords?: readonly MessageRecordWire[] }>,
  sessionId: SessionId,
): ConversationRecords {
  let source: readonly MessageRecordWire[] | undefined
  let mine: readonly MessageRecordWire[] = NO_RECORDS
  return {
    getSnapshot: () => {
      const all = store.getSnapshot().messageRecords ?? NO_RECORDS
      if (all !== source) {
        source = all
        const filtered = all.filter((record) => record.sessionId === sessionId)
        mine = filtered.length === 0 ? NO_RECORDS : filtered
      }
      return mine
    },
    subscribe: (listener) => subscribeTo(store, (s) => s.messageRecords, listener),
  }
}

/** The sends the outbox holds for this session. The outbox publishes its parked
 *  set whenever a send gives up, is retried or is discarded — from the chat or
 *  from the recovery panel — so that is the moment to look again. */
export function storeConversationOutbox(
  store: StoreSource<{
    readonly outboxDeadLetters?: unknown
    readonly chatSendsFor: (sessionId: SessionId) => readonly OutboxChatSend[]
  }>,
  sessionId: SessionId,
): ConversationOutbox {
  return {
    held: () => store.getSnapshot().chatSendsFor(sessionId),
    subscribe: (listener) => subscribeTo(store, (s) => s.outboxDeadLetters, listener),
  }
}
