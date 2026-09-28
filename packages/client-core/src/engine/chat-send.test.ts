/**
 * EVERY CHAT SEND GOES THROUGH THE OUTBOX (POD-4762) — on the kernel queue both
 * apps run, against a server that behaves like the real one: it stores the
 * message under the id it was sent with, and answers a repeat of that id with
 * the answer it gave the first time instead of storing a second message.
 *
 * The three properties the change exists for:
 *
 * 1. Offline, the send waits ON THE DEVICE and goes out once connectivity
 *    returns — exactly one message on the server.
 * 2. When the server stored the message but its answer was lost, the queue's
 *    own retry carries the SAME id, and the server's answer to it is the
 *    original one — still one message.
 * 3. When the queue gives up, the send says "not sent", and the user's retry
 *    re-issues the same message under the same id — never a new one.
 */

import { asMutationId, asSessionId, type MutationId } from '@podium/model'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { Replica } from '../replica/replica'
import {
  ChatNotSentError,
  discardChatThroughOutbox,
  OutboxSettlements,
  outboxChatSends,
  sendChatThroughOutbox,
} from './chat-send'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import { CHAT_SEND_MAX_AGE_MS, type EngineOutbox } from './wiring'

const SESSION = asSessionId('s-chat')

interface Row {
  readonly id: string
  readonly text: string
}

/**
 * The server's half: a message table keyed by the client's id, and the stored
 * answer for each id. `loseNextAnswer` commits the message and THEN fails the
 * transport — the answer, not the request, is what goes missing.
 */
function server() {
  const rows: Row[] = []
  const answers = new Map<string, unknown>()
  const calls: { mutationId: string; text: string }[] = []
  const state = { loseNextAnswer: false, refuse: undefined as string | undefined }
  const receive = async (input: { mutationId: string; text: string }): Promise<unknown> => {
    calls.push({ mutationId: input.mutationId, text: input.text })
    let answer = answers.get(input.mutationId)
    if (answer === undefined) {
      if (state.refuse !== undefined) {
        return { ok: false, disposition: 'dead_letter', reason: state.refuse }
      }
      rows.push({ id: input.mutationId, text: input.text })
      answer = { ok: true, disposition: 'queued', position: rows.length }
      answers.set(input.mutationId, answer)
    }
    if (state.loseNextAnswer) {
      state.loseNextAnswer = false
      throw new Error('fetch failed')
    }
    return answer
  }
  const api = {
    sessions: { sendText: { mutate: receive }, resumeAndSend: { mutate: receive } },
  } as unknown as PodiumClientApi
  return { api, rows, calls, state }
}

let online = true
const onlineListeners = new Set<() => void>()
const goOnline = (): void => {
  online = true
  for (const listener of onlineListeners) listener()
}

async function openQueue(api: PodiumClientApi): Promise<{
  outbox: EngineOutbox
  settlements: OutboxSettlements
}> {
  const settlements = new OutboxSettlements()
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore([]),
    principal: 'user-1',
    api,
    onDegraded: (detail) => {
      throw detail instanceof Error ? detail : new Error(String(detail))
    },
  })
  const outbox = create({
    api,
    replica: {} as Replica,
    notices: { error: () => {}, info: () => {} } as unknown as StoreNotices,
    onSettled: (mutationId, settlement) => settlements.settle(mutationId, settlement),
    isOnline: () => online,
    onlineEvents: {
      add: (listener) => onlineListeners.add(listener),
      remove: (listener) => onlineListeners.delete(listener),
    },
  })
  outbox.attach()
  return { outbox, settlements }
}

const MESSAGE_ID: MutationId = asMutationId('msg_the-one-message')

beforeEach(() => {
  vi.useFakeTimers()
  online = true
  onlineListeners.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a chat send rides the outbox under its own message id', () => {
  it('offline: waits on the device, then goes out on reconnect — one row', async () => {
    const authority = server()
    const queue = await openQueue(authority.api)
    online = false

    const sent = sendChatThroughOutbox(
      queue,
      { sessionId: SESSION, text: 'written in a tunnel', wake: false },
      MESSAGE_ID,
    )
    await vi.advanceTimersByTimeAsync(10_000)

    expect(authority.calls).toEqual([])
    expect(outboxChatSends(queue.outbox, SESSION)).toMatchObject([
      { mutationId: MESSAGE_ID, text: 'written in a tunnel', state: 'sending', wake: false },
    ])

    goOnline()
    await expect(sent).resolves.toEqual({ state: 'queued', position: 1 })
    expect(authority.rows).toEqual([{ id: MESSAGE_ID, text: 'written in a tunnel' }])
    expect(outboxChatSends(queue.outbox, SESSION)).toEqual([])
    queue.outbox.dispose()
  })

  it('answer lost after the server stored it: the retry returns the ORIGINAL answer — one row', async () => {
    const authority = server()
    authority.state.loseNextAnswer = true
    const queue = await openQueue(authority.api)

    const sent = sendChatThroughOutbox(
      queue,
      { sessionId: SESSION, text: 'did this land?', wake: false },
      MESSAGE_ID,
    )
    // The first attempt stored the row and lost the answer; the queue backs off
    // one second and asks again.
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(sent).resolves.toEqual({ state: 'queued', position: 1 })
    expect(authority.calls.map((call) => call.mutationId)).toEqual([MESSAGE_ID, MESSAGE_ID])
    expect(authority.rows).toHaveLength(1)
    queue.outbox.dispose()
  })

  it('gives up with "not sent" after the chat window, and the retry reuses the id', async () => {
    const authority = server()
    const queue = await openQueue(authority.api)
    online = false

    const sent = sendChatThroughOutbox(
      queue,
      { sessionId: SESSION, text: 'still there?', wake: false },
      MESSAGE_ID,
    )
    const verdict = sent.then(
      () => undefined,
      (error: unknown) => error,
    )
    // Nothing drains while offline — the give-up comes from the queue's own
    // clock, not from a drain that never runs.
    await vi.advanceTimersByTimeAsync(CHAT_SEND_MAX_AGE_MS + 1)

    const error = await verdict
    expect(error).toBeInstanceOf(ChatNotSentError)
    expect((error as ChatNotSentError).message).toBe("not sent — couldn't reach the server")
    expect((error as ChatNotSentError).retryable).toBe(true)
    expect(outboxChatSends(queue.outbox, SESSION)).toMatchObject([
      { mutationId: MESSAGE_ID, state: 'failed' },
    ])
    expect(authority.calls).toEqual([])

    // The user's retry — the same call, the same id.
    goOnline()
    await expect(
      sendChatThroughOutbox(
        queue,
        { sessionId: SESSION, text: 'still there?', wake: false },
        MESSAGE_ID,
      ),
    ).resolves.toEqual({ state: 'queued', position: 1 })
    expect(authority.calls.map((call) => call.mutationId)).toEqual([MESSAGE_ID])
    expect(authority.rows).toEqual([{ id: MESSAGE_ID, text: 'still there?' }])
    expect(outboxChatSends(queue.outbox, SESSION)).toEqual([])
    queue.outbox.dispose()
  })

  it('a send that landed but gave up before its answer came back: the retry is still one row', async () => {
    const authority = server()
    const queue = await openQueue(authority.api)
    // Every attempt reaches the server and loses its answer, until the window
    // closes: the message IS stored, the phone just never heard.
    authority.state.loseNextAnswer = true
    const lose = setInterval(() => {
      authority.state.loseNextAnswer = true
    }, 500)

    const verdict = sendChatThroughOutbox(
      queue,
      { sessionId: SESSION, text: 'twice?', wake: false },
      MESSAGE_ID,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(CHAT_SEND_MAX_AGE_MS + 1)
    clearInterval(lose)
    expect(await verdict).toBeInstanceOf(ChatNotSentError)

    authority.state.loseNextAnswer = false
    await expect(
      sendChatThroughOutbox(queue, { sessionId: SESSION, text: 'twice?', wake: false }, MESSAGE_ID),
    ).resolves.toEqual({ state: 'queued', position: 1 })
    // Many attempts, one id, one message.
    expect(new Set(authority.calls.map((call) => call.mutationId))).toEqual(new Set([MESSAGE_ID]))
    expect(authority.rows).toHaveLength(1)
    queue.outbox.dispose()
  })

  it('a refusal says why, cannot be retried as-is, and discard drops the queued copy', async () => {
    const authority = server()
    authority.state.refuse = 'session is archived'
    const queue = await openQueue(authority.api)

    const error = await sendChatThroughOutbox(
      queue,
      { sessionId: SESSION, text: 'hello?', wake: false },
      MESSAGE_ID,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ChatNotSentError)
    expect((error as ChatNotSentError).message).toBe('not sent — session is archived')
    expect((error as ChatNotSentError).retryable).toBe(false)
    expect(outboxChatSends(queue.outbox, SESSION)).toMatchObject([
      { mutationId: MESSAGE_ID, state: 'failed', failure: { retryable: false } },
    ])

    await discardChatThroughOutbox(queue.outbox, MESSAGE_ID)
    expect(outboxChatSends(queue.outbox, SESSION)).toEqual([])
    expect(queue.outbox.deadLetters()).toEqual([])
    queue.outbox.dispose()
  })

  it('a refused message does not hold the next one to the same session', async () => {
    const authority = server()
    authority.state.refuse = 'not now'
    const queue = await openQueue(authority.api)
    const refused = sendChatThroughOutbox(
      queue,
      { sessionId: SESSION, text: 'first', wake: false },
      asMutationId('msg_first'),
    ).catch(() => 'refused')
    expect(await refused).toBe('refused')

    authority.state.refuse = undefined
    await expect(
      sendChatThroughOutbox(
        queue,
        { sessionId: SESSION, text: 'second', wake: false },
        asMutationId('msg_second'),
      ),
    ).resolves.toEqual({ state: 'queued', position: 1 })
    queue.outbox.dispose()
  })

  it('sends a parked session its message as a wake, under the same id', async () => {
    const authority = server()
    const queue = await openQueue(authority.api)
    const woke = vi.spyOn(
      authority.api.sessions.resumeAndSend as unknown as { mutate: () => unknown },
      'mutate',
    )

    await expect(
      sendChatThroughOutbox(queue, { sessionId: SESSION, text: 'wake up', wake: true }, MESSAGE_ID),
    ).resolves.toEqual({ state: 'queued' })
    expect(woke).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, text: 'wake up', mutationId: MESSAGE_ID }),
    )
    queue.outbox.dispose()
  })
})
