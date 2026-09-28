/**
 * The store's chat-send actions over the REAL outbox (POD-4762), draining into
 * a test's fake tRPC.
 *
 * Every chat send goes through the kernel outbox now, so a test that mocks the
 * store must not stub `sendChat` into something the product no longer does. This
 * wires the same three actions the engine exposes — `sendChat`, `chatSendsFor`,
 * `discardChat` — to a kernel queue over an in-memory store, whose executor calls
 * the fake `sessions.sendText` / `sessions.resumeAndSend`. What the test asserts
 * about those fakes is then what the server would really receive: the message
 * id, the retry under the same id, the give-up.
 *
 * Synchronous to construct so a hoisted `vi.mock('@/app/store')` factory can
 * reach it; the queue itself opens on the first send.
 */

import type { PodiumClientApi } from '@podium/client-core'
import {
  type ChatSendInput,
  type ChatSendOutcome,
  discardChatThroughOutbox,
  type EngineOutbox,
  newChatMessageId,
  type OutboxChatSend,
  OutboxSettlements,
  openKernelEngineOutbox,
  outboxChatSends,
  sendChatThroughOutbox,
} from '@podium/client-core/engine'
import type { MutationId, SessionId } from '@podium/model'
import { InMemoryOutboxStore } from '@podium/sync/outbox'

interface Opened {
  readonly outbox: EngineOutbox
  readonly settlements: OutboxSettlements
}

export interface OutboxChatSendActions {
  sendChat(input: ChatSendInput, mutationId?: MutationId): Promise<ChatSendOutcome>
  chatSendsFor(sessionId: SessionId): OutboxChatSend[]
  discardChat(mutationId: MutationId): Promise<void>
  /** The open queue, once a send opened it. */
  outbox(): EngineOutbox | undefined
  /** Drop the queue and everything in it — call between tests. */
  reset(): void
}

export function outboxChatSendActions(api: () => unknown): OutboxChatSendActions {
  let opening: Promise<Opened> | undefined
  let opened: Opened | undefined
  const open = (): Promise<Opened> => {
    opening ??= (async () => {
      const settlements = new OutboxSettlements()
      const create = await openKernelEngineOutbox({
        store: new InMemoryOutboxStore(),
        principal: 'test-user',
        api: api() as PodiumClientApi,
        onDegraded: () => {},
      })
      const outbox = create({
        api: api() as PodiumClientApi,
        replica: {} as never,
        notices: { error: () => {}, info: () => {} },
        onSettled: (mutationId, settlement) => settlements.settle(mutationId, settlement),
        isOnline: () => true,
        onlineEvents: { add: () => {}, remove: () => {} },
      })
      outbox.attach()
      opened = { outbox, settlements }
      return opened
    })()
    return opening
  }
  return {
    sendChat: async (input, mutationId) =>
      sendChatThroughOutbox(await open(), input, mutationId ?? newChatMessageId()),
    chatSendsFor: (sessionId) => (opened ? outboxChatSends(opened.outbox, sessionId) : []),
    discardChat: async (mutationId) => {
      if (opened) await discardChatThroughOutbox(opened.outbox, mutationId)
    },
    outbox: () => opened?.outbox,
    reset: () => {
      opened?.outbox.dispose()
      opened = undefined
      opening = undefined
    },
  }
}
