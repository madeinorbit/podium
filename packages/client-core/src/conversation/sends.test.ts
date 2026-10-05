import {
  asSessionId,
  type MessageRecordWire,
  type SessionOffer,
  type TranscriptItem,
} from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { OutboxChatSend } from '../engine/chat-send'
import { createSendsFixture } from './model-test-support'
import type { ConversationPendingTurn } from './projection'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** A port whose value the test moves, like the transcript and the store. */
function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    port: {
      getSnapshot: () => value,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    get: () => value,
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

function transcript() {
  const items = source<{ items: TranscriptItem[] }>({ items: [] })
  return { port: items.port, set: (next: TranscriptItem[]) => items.set({ items: next }) }
}

function records(initial: MessageRecordWire[] = []) {
  return source<readonly MessageRecordWire[]>(initial)
}

function user(id: string, text: string, extras: Partial<TranscriptItem> = {}): TranscriptItem {
  return { id, role: 'user', text, ...extras }
}

function record(id: string, over: Partial<MessageRecordWire> = {}): MessageRecordWire {
  return {
    id,
    sessionId: asSessionId('s1'),
    senderUserId: 'usr_me',
    body: `the words of ${id}`,
    createdAt: '2026-09-29T10:00:00.000Z',
    status: 'stored',
    ...over,
  }
}

function offer(createdAt = '2026-08-30T12:00:00.000Z'): SessionOffer {
  return { message: 'Choose', actions: [{ label: 'Do it', prompt: 'do it' }], createdAt }
}

const states = (controller: {
  getSnapshot(): { bubbles: { deliveryId: string; state: string }[] }
}) => controller.getSnapshot().bubbles.map((bubble) => `${bubble.deliveryId}:${bubble.state}`)

/**
 * A MESSAGE'S BUBBLE FOLLOWS ITS SYNCED RECORD, BY ID (POD-4764). This device's
 * send shows until the server's record of it arrives; the record says where it
 * stands; the bubble leaves when the history entry the record names is on
 * screen. No ledger poll, and no transcript text is ever compared.
 */
describe('MobX sends over synced records', () => {
  it('does not publish transcript freshness or assistant text changes as conversation changes', () => {
    const feed = transcript()
    feed.set([user('u1', 'prompt'), { id: 'a1', role: 'assistant', text: 'partial' }])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'local',
      deliver: vi.fn(),
    })
    controller.start()
    const notify = vi.fn()
    controller.subscribe(notify)
    const items = [user('u1', 'prompt'), { id: 'a1', role: 'assistant' as const, text: 'complete' }]
    feed.set(items)
    feed.set(items)
    expect(notify).not.toHaveBeenCalled()
    controller.dispose()
  })
  it('acknowledges a confirmation that arrives after the native entry was windowed out', () => {
    const feed = transcript()
    const synced = records([
      record('sent', { status: 'typed', transcriptItem: { id: 'native', cursor: 'c1' } }),
    ])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      records: synced.port,
      createDeliveryId: () => 'local',
      deliver: vi.fn(),
    })
    controller.start()
    feed.set([user('native', 'delivered')])
    feed.set([user('later', 'later')])
    expect(controller.getSnapshot().bubbles).toEqual([])
    synced.set([
      record('sent', { status: 'confirmed', transcriptItem: { id: 'native', cursor: 'c1' } }),
    ])
    expect(controller.getSnapshot().bubbles).toEqual([])
    controller.dispose()
  })
  it('hands a send over to its record, and drops it when the named history entry arrives', async () => {
    const feed = transcript()
    const synced = records()
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      records: synced.port,
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'sent' }),
    })
    controller.start()
    await controller.submit({ text: 'please ship it' })
    expect(states(controller)).toEqual(['msg-1:sent'])

    synced.set([record('msg-1', { body: 'please ship it', status: 'stored' })])
    expect(states(controller)).toEqual(['msg-1:queued'])
    expect(controller.getSnapshot().bubbles[0]?.retractable).toBe(true)
    synced.set([record('msg-1', { body: 'please ship it', status: 'typed' })])
    expect(states(controller)).toEqual(['msg-1:sent'])
    synced.set([
      record('msg-1', { status: 'confirmed', transcriptItem: { id: 'entry-7', cursor: 'c7' } }),
    ])
    expect(states(controller)).toEqual(['msg-1:sent'])

    // The history carries it under DIFFERENT text — the harness rewrote it —
    // and the id alone retires the bubble: the message shows once.
    feed.set([user('entry-7', '<user_query>please ship it</user_query>')])
    expect(controller.getSnapshot().bubbles).toEqual([])
    expect(controller.getSnapshot().pending).toEqual([])
    // A rolling live window must not resurrect a completed send's bubble.
    feed.set([user('entry-8', 'later prompt')])
    expect(controller.getSnapshot().bubbles).toEqual([])
    controller.dispose()
  })

  it('never retires a bubble on matching text', async () => {
    const feed = transcript()
    const synced = records([record('msg-1', { body: 'same words', status: 'typed' })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    feed.set([user('entry-1', 'same words')])
    expect(states(controller)).toEqual(['msg-1:sent'])
    controller.dispose()
  })

  it('shows a message sent from another device, with the status its record carries', () => {
    const synced = records([record('msg-other', { status: 'dispatched' })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-other', text: 'the words of msg-other', state: 'sent', retractable: true },
    ])
    synced.set([record('msg-other', { status: 'unknown' })])
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-other', state: 'unknown', notice: 'unknown' },
    ])
    controller.dispose()
  })

  it('says the agent has a message its program accepted, still on its way, too late to retract (POD-4885)', () => {
    const synced = records([record('msg-a', { status: 'accepted' })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-a', state: 'accepted', retractable: false },
    ])
    expect(controller.getSnapshot().bubbles[0]).not.toHaveProperty('notice')
    synced.set([
      record('msg-a', { status: 'accepted', retractRequestedAt: '2026-09-29T10:00:01.000Z' }),
    ])
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-a', state: 'accepted', retract: 'too-late' },
    ])
    // It can still be the latest delivery a Stop is aimed at: the agent has it.
    expect(controller.getSnapshot().interruptMessageId).toBe('msg-a')
    controller.dispose()
  })

  // THE OLD-CLIENT CASE, ONE RELEASE ON (POD-4885). A record read by id comes
  // without a schema, so a status a newer server added reaches the projection
  // as it is — this build meeting `accepted` before it knew it was the same
  // case. It must read as still on its way, and nothing may throw.
  it('reads a record whose status this build does not know as on its way, and does not throw', () => {
    const unknownToThisBuild = 'a-status-from-a-newer-server' as MessageRecordWire['status']
    const synced = records([record('msg-new-status', { status: unknownToThisBuild })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    expect(() => controller.start()).not.toThrow()
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-new-status', state: 'sent', retractable: false },
    ])
    synced.set([
      record('msg-new-status', {
        status: unknownToThisBuild,
        retractRequestedAt: '2026-09-29T10:00:01.000Z',
      }),
    ])
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-new-status', state: 'sent', retract: 'too-late' },
    ])
    controller.dispose()
  })

  it('shows no bubble for a record first seen confirmed — that is history', () => {
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records([record('msg-old', { status: 'confirmed', transcriptItem: { id: 'e1' } })])
        .port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    expect(controller.getSnapshot().bubbles).toEqual([])
    controller.dispose()
  })

  it('lets a confirmed record that names no history entry go: there is no id to wait for', () => {
    const synced = records([record('msg-1', { status: 'typed' })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    synced.set([record('msg-1', { status: 'confirmed' })])
    expect(controller.getSnapshot().bubbles).toEqual([])
    controller.dispose()
  })

  it('drops a send whose record came and went (cancelled, dismissed, out of the window)', async () => {
    const synced = records()
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'queued' }),
    })
    controller.start()
    await controller.submit({ text: 'maybe' })
    // Answered, but the feed has not carried the record yet: it keeps showing.
    expect(states(controller)).toEqual(['msg-1:queued'])
    synced.set([record('msg-1', { body: 'maybe' })])
    synced.set([])
    expect(controller.getSnapshot().bubbles).toEqual([])
    expect(controller.getSnapshot().pending).toEqual([])
    controller.dispose()
  })

  // POD-4776: a retract is a request the agent's machine answers, and the
  // bubble says where it stands — never a silent vanish.
  it('a retract says it is on its way, then retracted when the server says cancelled', async () => {
    const synced = records([record('msg-1', { status: 'dispatched' })])
    const answer = deferred<MessageRecordWire['status']>()
    const retract = vi.fn(() => answer.promise)
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
      retract,
    })
    controller.start()
    expect(controller.getSnapshot().bubbles).toMatchObject([{ state: 'sent', retractable: true }])
    const retracting = controller.retract('msg-1')
    expect(retract).toHaveBeenCalledWith('msg-1')
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-1', retract: 'requested', retractable: false },
    ])
    answer.resolve('cancelled')
    await retracting
    // The record leaves the feed; the answer stays on this device.
    synced.set([])
    expect(states(controller)).toEqual(['msg-1:retracted'])
    expect(controller.getSnapshot().interruptMessageId).toBeNull()
    controller.dispose()
  })

  it('a retract that came too late says so, from the record, on every device', async () => {
    const synced = records([record('msg-1', { status: 'dispatched' })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
      retract: async () => {
        synced.set([
          record('msg-1', { status: 'typing', retractRequestedAt: '2026-09-29T10:00:01.000Z' }),
        ])
        return 'typing'
      },
    })
    controller.start()
    await controller.retract('msg-1')
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-1', state: 'sent', retract: 'too-late', retractable: false },
    ])
    // A retract still waiting for the machine reads as asked, not as done.
    synced.set([
      record('msg-1', { status: 'dispatched', retractRequestedAt: '2026-09-29T10:00:01.000Z' }),
    ])
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { deliveryId: 'msg-1', retract: 'requested', retractable: false },
    ])
    controller.dispose()
  })

  it('a retract that fails says why on the bubble, and the bubble stays retractable', async () => {
    const synced = records([record('msg-1', { status: 'stored' })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
      retract: async () => {
        throw new Error('server unreachable')
      },
    })
    controller.start()
    await controller.retract('msg-1')
    expect(controller.getSnapshot().bubbles).toMatchObject([
      {
        deliveryId: 'msg-1',
        state: 'queued',
        retractable: true,
        retractError: 'server unreachable',
      },
    ])
    controller.dispose()
  })

  it('retract shows exactly while the status still allows it to win', () => {
    const statuses: MessageRecordWire['status'][] = [
      'stored',
      'dispatched',
      'reached-machine',
      'typing',
      'typed',
      'unknown',
      'failed',
    ]
    const synced = records(statuses.map((status, index) => record(`msg-${index}`, { status })))
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
      retract: vi.fn(),
    })
    controller.start()
    expect(
      controller.getSnapshot().bubbles.map((bubble) => [bubble.record?.status, bubble.retractable]),
    ).toEqual([
      ['stored', true],
      ['dispatched', true],
      ['reached-machine', true],
      ['typing', false],
      ['typed', false],
      ['unknown', true],
      ['failed', false],
    ])
    controller.dispose()
  })

  it('a send still in this device outbox is discarded here, never asked of the server', async () => {
    const held: OutboxChatSend[] = []
    const outboxListeners = new Set<() => void>()
    const discard = vi.fn(async (id: string) => {
      held.splice(
        held.findIndex((send) => send.mutationId === id),
        1,
      )
    })
    const retract = vi.fn()
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      outbox: {
        held: () => held,
        subscribe: (listener) => {
          outboxListeners.add(listener)
          return () => outboxListeners.delete(listener)
        },
      },
      createDeliveryId: () => 'msg-1',
      // Never answered: the server is out of reach and the outbox holds it.
      deliver: () => new Promise(() => {}),
      discard,
      retract,
    })
    controller.start()
    void controller.submit({ text: 'not yet' })
    held.push({
      mutationId: 'msg-1' as OutboxChatSend['mutationId'],
      sessionId: asSessionId('s1'),
      text: 'not yet',
      wake: false,
      queuedAt: 0,
      state: 'sending',
    })
    await vi.waitFor(() => expect(states(controller)).toEqual(['msg-1:sending']))
    expect(controller.getSnapshot().bubbles[0]?.retractable).toBe(true)
    await controller.retract(controller.getSnapshot().bubbles[0]!.id)
    expect(discard).toHaveBeenCalledWith('msg-1')
    expect(retract).not.toHaveBeenCalled()
    expect(states(controller)).toEqual(['msg-1:retracted'])
    controller.dispose()
  })

  it("a send already on its way to the server is the server's to answer", async () => {
    const held: OutboxChatSend[] = [
      {
        mutationId: 'msg-1' as OutboxChatSend['mutationId'],
        sessionId: asSessionId('s1'),
        text: 'in flight',
        wake: false,
        queuedAt: 0,
        state: 'sending',
      },
    ]
    const retract = vi.fn(async () => 'cancelled' as const)
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      outbox: { held: () => held, subscribe: () => () => {} },
      createDeliveryId: () => 'msg-1',
      deliver: () => new Promise(() => {}),
      // The outbox refuses to discard an entry it is sending right now.
      discard: async () => {
        throw new Error('cannot discard msg-1 from sending')
      },
      retract,
    })
    controller.start()
    void controller.submit({ text: 'in flight' })
    await controller.retract(controller.getSnapshot().bubbles[0]!.id)
    expect(retract).toHaveBeenCalledWith('msg-1')
    expect(states(controller)).toEqual(['msg-1:retracted'])
    controller.dispose()
  })

  it('offers "send again" on a message the server says did not arrive: the text returns to the composer and the notice goes', async () => {
    const synced = records([record('msg-1', { status: 'failed', reason: 'teardown' })])
    const dismissNotice = vi.fn(async () => {
      synced.set([])
    })
    const deliver = vi.fn()
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: synced.port,
      createDeliveryId: () => 'msg-new',
      deliver,
      dismissNotice,
    })
    controller.start()
    expect(controller.getSnapshot().bubbles).toMatchObject([
      { state: 'failed', notice: 'failed', error: 'not delivered · session torn down' },
    ])
    // Not a resend of this message: retry does nothing for a server notice.
    await controller.retry('msg-1')
    expect(deliver).not.toHaveBeenCalled()

    await controller.sendAgain('msg-1')
    expect(controller.getSnapshot().draft).toBe('the words of msg-1')
    expect(dismissNotice).toHaveBeenCalledWith('msg-1')
    expect(deliver).not.toHaveBeenCalled()
    expect(controller.getSnapshot().bubbles).toEqual([])
    controller.dispose()
  })

  it('follows the outbox when a send that gave up is retried or discarded elsewhere', async () => {
    const sends = source<readonly OutboxChatSend[]>([])
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("not sent — couldn't reach the server"), {
          retryable: true,
        }),
      )
      .mockResolvedValueOnce({ state: 'sent' })
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      outbox: { held: () => sends.get(), subscribe: sends.port.subscribe },
      createDeliveryId: () => 'msg-1',
      deliver,
    })
    controller.start()
    await controller.submit({ text: 'from the tunnel' })
    expect(states(controller)).toEqual(['msg-1:failed'])

    // The recovery panel re-issues the SAME entry: the bubble follows it again.
    const held = {
      mutationId: 'msg-1',
      sessionId: asSessionId('s1'),
      text: 'from the tunnel',
      wake: false,
      queuedAt: 1,
    } as unknown as OutboxChatSend
    sends.set([{ ...held, state: 'sending' }])
    expect(states(controller)).toEqual(['msg-1:sending'])
    await vi.waitFor(() => expect(states(controller)).toEqual(['msg-1:sent']))
    expect(deliver.mock.calls.map(([turn]) => turn.deliveryId)).toEqual(['msg-1', 'msg-1'])
    controller.dispose()
  })

  it('lets a failed send go when the outbox no longer holds it', async () => {
    const sends = source<readonly OutboxChatSend[]>([])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      outbox: { held: () => sends.get(), subscribe: sends.port.subscribe },
      createDeliveryId: () => 'msg-1',
      deliver: async () => {
        throw new Error("not sent — couldn't reach the server")
      },
    })
    controller.start()
    await controller.submit({ text: 'never mind' })
    expect(states(controller)).toEqual(['msg-1:failed'])
    sends.set([])
    expect(controller.getSnapshot().bubbles).toEqual([])
    controller.dispose()
  })

  it('retires a send with no record by the next user entry, whatever its text', async () => {
    const feed = transcript()
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      reconcile: 'next-user-item',
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'sent' }),
    })
    controller.start()
    await controller.submit({ text: 'first' })
    await controller.submit({ text: 'second' })
    feed.set([user('u1', 'something else entirely')])
    expect(controller.getSnapshot().bubbles.map((bubble) => bubble.text)).toEqual(['second'])
    controller.dispose()
  })
})

describe('MobX sends contract', () => {
  it('owns a controlled draft, exact-wire retry and offer restoration', async () => {
    const drafts: string[] = []
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error('not sent'))
      .mockResolvedValueOnce({ state: 'queued' })
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      initialDraft: 'remembered',
      onDraftChange: (text) => drafts.push(text),
      createDeliveryId: () => 'msg-1',
      deliver,
      dismissOffer: vi.fn(async () => {}),
    })
    controller.start()
    controller.updateContext({ canInterrupt: true, offer: offer(), agentPhase: 'idle' })
    controller.setDraft('edited')
    await controller.submit({
      text: 'look',
      wire: '/uploads/shot.png\nlook',
      toolPaths: ['/uploads/shot.png'],
    })
    expect(drafts).toEqual(['edited', ''])
    expect(controller.getSnapshot().offer).toEqual(offer())
    expect(controller.getSnapshot().pending[0]).toMatchObject({ state: 'failed' })

    await controller.retry('pending-1')
    expect(deliver.mock.calls.map(([turn]) => turn.wire)).toEqual([
      '/uploads/shot.png\nlook',
      '/uploads/shot.png\nlook',
    ])
    expect(controller.getSnapshot().pending[0]).toMatchObject({ state: 'queued' })
    controller.dispose()
  })

  it('keys optimistic offer state by createdAt so a replacement remains visible', async () => {
    const feed = transcript()
    let reject!: (cause: unknown) => void
    const delivered = new Promise<void>((_resolve, no) => {
      reject = no
    })
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: () => delivered,
    })
    controller.start()
    controller.updateContext({ canInterrupt: false, offer: offer('old') })
    const sending = controller.sendOffer('answer', 'old')
    expect(controller.getSnapshot().offer).toBeNull()
    controller.updateContext({ canInterrupt: false, offer: offer('new') })
    expect(controller.getSnapshot().offer?.createdAt).toBe('new')
    reject(new Error('refused'))
    await expect(sending).rejects.toThrow('refused')
    expect(controller.getSnapshot().offer?.createdAt).toBe('new')
    controller.dispose()
  })

  it('owns interrupt capability, draft recall, and refusal state', async () => {
    const feed = transcript()
    const interrupt = vi.fn().mockRejectedValue(new Error('agent is idle'))
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: vi.fn(),
      interrupt,
    })
    controller.start()
    controller.updateContext({
      canInterrupt: true,
      latestOperatorPrompt: 'last prompt',
      agentPhase: 'working',
      agentSince: 't1',
    })
    expect(await controller.interrupt('')).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      draft: 'last prompt',
      canInterrupt: true,
      interruptError: 'agent is idle',
    })
    controller.updateContext({ canInterrupt: false })
    expect(await controller.interrupt()).toBe(false)
    expect(interrupt).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('correlates a successful interrupt to the open delivery and keeps its bubble', async () => {
    const feed = transcript()
    const interrupt = vi.fn(async (_messageId?: string) => {})
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'queued' }),
      interrupt,
    })
    controller.start()
    controller.updateContext({ canInterrupt: true, agentPhase: 'working' })
    await controller.submit({ text: 'stop this' })
    expect(controller.getSnapshot().interruptMessageId).toBe('msg-1')
    expect(await controller.interrupt()).toBe(true)
    expect(interrupt).toHaveBeenCalledWith('msg-1')
    expect(controller.getSnapshot()).toMatchObject({
      interruptMessageId: null,
      pending: [expect.objectContaining({ deliveryId: 'msg-1', state: 'interrupted' })],
    })
    controller.dispose()
  })

  it('a Stop that lands ends "just sent" at once, not at the send ceiling (POD-4654)', async () => {
    // The phone's send resolves on ENQUEUE, and a Stop pressed at once retracts
    // it before the agent sees it: no echo and no turn will ever move the
    // session, so only the 30 s ceiling cleared the flag — and the Stop control
    // it keeps up stayed on screen that long after a Stop that had worked.
    const feed = transcript()
    const timers: Array<() => void> = []
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'queued' }),
      interrupt: async () => {},
      clock: {
        now: () => 0,
        setTimeout: (callback) => timers.push(callback),
        clearTimeout: () => {},
      },
    })
    controller.start()
    controller.updateContext({ canInterrupt: true, agentPhase: 'idle', agentSince: 't0' })
    await controller.submit({ text: 'Write the numbers from 1 to 400' })
    expect(controller.getSnapshot().justSent).toBe(true)

    expect(await controller.interrupt()).toBe(true)

    expect(controller.getSnapshot().justSent).toBe(false)
    controller.dispose()
  })

  it('a refused Stop leaves "just sent" to the send it did not stop', async () => {
    const feed = transcript()
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'queued' }),
      interrupt: async () => {
        throw new Error('agent is idle')
      },
      clock: {
        now: () => 0,
        setTimeout: () => 0,
        clearTimeout: () => {},
      },
    })
    controller.start()
    controller.updateContext({ canInterrupt: true, agentPhase: 'idle', agentSince: 't0' })
    await controller.submit({ text: 'Write the numbers from 1 to 400' })

    expect(await controller.interrupt()).toBe(false)

    expect(controller.getSnapshot().justSent).toBe(true)
    controller.dispose()
  })
})

/**
 * THE BUBBLE READS ITS STATE FROM THE SEND (POD-4762). The adapter's `deliver`
 * settles when the durable send does — the server answered, or the outbox gave
 * up — so the controller keeps no timer of its own, follows a send it was handed
 * from before it existed, and lets a failed one go through the adapter.
 */
describe('MobX sends over a durable send', () => {
  const held = {
    id: 'outbox-0-msg_held',
    deliveryId: 'msg_held',
    text: 'written before the reload',
    wire: 'written before the reload',
    at: 1,
    state: 'sending' as const,
    kind: 'message' as const,
  }

  it('follows a send it was seeded with, once, and takes its state from the outcome', async () => {
    const outcome = deferred<{ state: 'queued' }>()
    const deliver = vi.fn(() => outcome.promise)
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      initialPending: [held],
      createDeliveryId: () => 'msg-new',
      deliver,
    })

    // A StrictMode rehearsal: start, stop, start. The send is asked after once.
    controller.start()
    controller.stop()
    controller.start()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'msg_held' }))
    // Following a held send is not a new send: nothing reads as "just sent".
    expect(controller.getSnapshot().justSent).toBe(false)

    outcome.resolve({ state: 'queued' })
    await outcome.promise
    await Promise.resolve()
    expect(controller.getSnapshot().pending[0]).toMatchObject({
      deliveryId: 'msg_held',
      state: 'queued',
    })
    controller.dispose()
  })

  it('keeps a send `sending` for as long as it is — no timer relabels it', async () => {
    vi.useFakeTimers()
    try {
      const controller = createSendsFixture({
        sessionId: asSessionId('s1'),
        transcript: transcript().port,
        createDeliveryId: () => 'msg-1',
        deliver: () => new Promise(() => {}),
      })
      controller.start()
      void controller.submit({ text: 'offline for a while' })
      await vi.advanceTimersByTimeAsync(90_000)
      expect(controller.getSnapshot().pending[0]?.state).toBe('sending')
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers no retry of words the server refused, and discards through the adapter', async () => {
    const refused = Object.assign(new Error('not sent — session is archived'), {
      retryable: false,
    })
    const deliver = vi.fn(async () => {
      throw refused
    })
    const discard = vi.fn(async () => {})
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      createDeliveryId: () => 'msg-refused',
      deliver,
      discard,
    })
    controller.start()
    await controller.submit({ text: 'hello?' })
    expect(controller.getSnapshot().pending[0]).toMatchObject({
      state: 'failed',
      error: 'not sent — session is archived',
      retryable: false,
    })

    await controller.retry('pending-1')
    expect(deliver).toHaveBeenCalledTimes(1)

    await controller.discard('pending-1')
    expect(discard).toHaveBeenCalledWith('msg-refused')
    expect(controller.getSnapshot().pending).toEqual([])
    controller.dispose()
  })

  it('retries a send that gave up as the SAME delivery', async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("not sent — couldn't reach the server"), { retryable: true }),
      )
      .mockResolvedValueOnce({ state: 'sent' })
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      createDeliveryId: () => 'msg-once',
      deliver,
    })
    controller.start()
    await controller.submit({ text: 'again' })
    expect(controller.getSnapshot().pending[0]?.state).toBe('failed')

    await controller.retry('pending-1')
    expect(deliver.mock.calls.map(([turn]) => turn.deliveryId)).toEqual(['msg-once', 'msg-once'])
    expect(controller.getSnapshot().pending[0]?.state).toBe('sent')
    controller.dispose()
  })
})

/** A link to the server the test takes down and brings back. */
function link(initial = true) {
  let connected = initial
  const listeners = new Set<(connected: boolean) => void>()
  return {
    port: {
      connected: () => connected,
      subscribe(listener: (connected: boolean) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set(next: boolean) {
      connected = next
      for (const listener of listeners) listener(next)
    },
  }
}

/** A turn this view was handed from before it existed — a reload. */
const seeded = (
  deliveryId: string,
  state: ConversationPendingTurn['state'],
  over: Partial<ConversationPendingTurn> = {},
): ConversationPendingTurn => ({
  id: `o-${deliveryId}`,
  deliveryId,
  text: `the words of ${deliveryId}`,
  wire: `the words of ${deliveryId}`,
  at: 1,
  state,
  kind: 'message',
  ...over,
})

const heldSend = (mutationId: string, state: OutboxChatSend['state']): OutboxChatSend =>
  ({
    mutationId,
    sessionId: asSessionId('s1'),
    text: `the words of ${mutationId}`,
    wake: false,
    queuedAt: 1,
    state,
  }) as unknown as OutboxChatSend

/**
 * A DEVICE AWAY FOR LONG SETTLES ITS OWN BUBBLES BY ID (POD-4811). The feed
 * carries a confirmed message only for its session's last few confirmations;
 * a device that was away longer never sees the record of what it sent. On
 * start and whenever it is back online, it asks the server for every one of
 * its sends the feed does not carry, in one read, and settles the bubbles from
 * the answer. An id the server does not know never reads as "on its way".
 */
describe('MobX sends catching up by id', () => {
  it('settles the bubbles of a device that was away longer than the window, on reconnect, in one read', async () => {
    const feed = transcript()
    const net = link()
    const ids = ['msg-1', 'msg-2', 'msg-3']
    const lookup = vi.fn(async (asked: readonly string[]) =>
      asked.map((id) =>
        id === 'msg-3'
          ? record(id, { status: 'confirmed' })
          : record(id, {
              status: 'confirmed',
              transcriptItem: { id: `entry-${id}`, cursor: `c-${id}` },
            }),
      ),
    )
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      records: records().port,
      lookupRecords: lookup,
      connection: net.port,
      createDeliveryId: () => ids.shift() ?? 'msg-x',
      deliver: async () => ({ state: 'sent' }),
    })
    controller.start()
    await controller.submit({ text: 'one' })
    await controller.submit({ text: 'two' })
    await controller.submit({ text: 'three' })
    // Sent, and the device goes away before the feed carries any of them; by
    // the time it is back they were confirmed and left the feed.
    net.set(false)
    expect(states(controller)).toEqual(['msg-1:sent', 'msg-2:sent', 'msg-3:sent'])
    lookup.mockClear()
    net.set(true)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith(['msg-1', 'msg-2', 'msg-3'])
    // Confirmed, naming nothing: the history shows it without a bubble. The
    // two that name an entry wait for it, and leave once it is on screen.
    await vi.waitFor(() => expect(states(controller)).toEqual(['msg-1:sent', 'msg-2:sent']))
    feed.set([user('entry-msg-1', 'one'), user('entry-msg-2', 'two')])
    expect(controller.getSnapshot().bubbles).toEqual([])
    controller.dispose()
  })

  it('asks at start for the sends a reload seeded, and follows what the server holds', async () => {
    const lookup = vi.fn(async () => [record('msg_held', { status: 'stored' })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      lookupRecords: lookup,
      initialPending: [seeded('msg_held', 'sending')],
      createDeliveryId: () => 'msg-new',
      deliver: () => new Promise(() => {}),
    })
    controller.start()
    expect(lookup).toHaveBeenCalledWith(['msg_held'])
    await vi.waitFor(() => expect(states(controller)).toEqual(['msg_held:queued']))
    controller.dispose()
  })

  it('never asks for what the feed carries', () => {
    const lookup = vi.fn(async () => [])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records([record('msg-1', { status: 'dispatched' })]).port,
      lookupRecords: lookup,
      // A reload: this view was handed the send, and the feed carries it.
      initialPending: [seeded('msg-1', 'sent')],
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    expect(lookup).not.toHaveBeenCalled()
    expect(states(controller)).toEqual(['msg-1:sent'])
    controller.dispose()
  })

  it('an id the server does not know stays honest: "not sent" once gone, the outbox’s word while it holds it', async () => {
    const net = link()
    const lookup = vi.fn(async () => [] as MessageRecordWire[])
    const outbox = source<readonly OutboxChatSend[]>([
      heldSend('msg-trying', 'sending'),
      heldSend('msg-parked', 'failed'),
    ])
    const ids = ['msg-gone']
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      outbox: { held: () => outbox.get(), subscribe: outbox.port.subscribe },
      lookupRecords: lookup,
      connection: net.port,
      initialPending: [
        seeded('msg-trying', 'sending'),
        seeded('msg-parked', 'failed', { at: 2, error: "not sent — couldn't reach the server" }),
      ],
      createDeliveryId: () => ids.shift() ?? 'msg-x',
      deliver: (turn) =>
        turn.deliveryId === 'msg-gone' ? Promise.resolve({ state: 'sent' }) : new Promise(() => {}),
    })
    controller.start()
    await controller.submit({ text: 'the device thought this went' })
    net.set(false)
    net.set(true)
    await vi.waitFor(() =>
      expect(controller.getSnapshot().bubbles).toMatchObject([
        { deliveryId: 'msg-trying', state: 'sending' },
        {
          deliveryId: 'msg-parked',
          state: 'failed',
          error: "not sent — couldn't reach the server",
        },
        {
          deliveryId: 'msg-gone',
          state: 'failed',
          error: 'not sent — the server has no record of it',
        },
      ]),
    )
    // "Not sent" with the way on: a retry of the same message.
    expect(controller.getSnapshot().bubbles[2]?.notice).toBeUndefined()
    expect(controller.getSnapshot().bubbles[2]?.retryable).not.toBe(false)
    controller.dispose()
  })

  it('does not call a send "not sent" that got its answer while the read was out', async () => {
    const answer = deferred<MessageRecordWire[]>()
    const sent = deferred<{ state: 'sent' }>()
    const lookup = vi.fn(() => answer.promise)
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      lookupRecords: lookup,
      initialPending: [seeded('msg-1', 'sending')],
      createDeliveryId: () => 'msg-new',
      deliver: () => sent.promise,
    })
    controller.start()
    expect(lookup).toHaveBeenCalledWith(['msg-1'])
    // The server stores it after the read looked, and answers the send.
    sent.resolve({ state: 'sent' })
    await vi.waitFor(() => expect(states(controller)).toEqual(['msg-1:sent']))
    answer.resolve([])
    await answer.promise
    await Promise.resolve()
    expect(states(controller)).toEqual(['msg-1:sent'])
    controller.dispose()
  })

  it('shows nothing for a message whose notice its sender already dismissed elsewhere', async () => {
    const lookup = vi.fn(async () => [
      record('msg-1', { status: 'failed', noticeDismissedAt: '2026-09-29T11:00:00.000Z' }),
    ])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      lookupRecords: lookup,
      initialPending: [seeded('msg-1', 'sent')],
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    await vi.waitFor(() => expect(controller.getSnapshot().bubbles).toEqual([]))
    controller.dispose()
  })

  it('lets go of the outbox’s parked copy of a message the server turns out to have', async () => {
    const outbox = source<readonly OutboxChatSend[]>([heldSend('msg-1', 'failed')])
    const discard = vi.fn(async () => {
      outbox.set([])
    })
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      outbox: { held: () => outbox.get(), subscribe: outbox.port.subscribe },
      lookupRecords: async () => [record('msg-1', { status: 'dispatched' })],
      discard,
      initialPending: [
        seeded('msg-1', 'failed', { error: "not sent — couldn't reach the server" }),
      ],
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('msg-1'))
    // It went: the bubble says so, not "not sent".
    expect(states(controller)).toEqual(['msg-1:sent'])
    controller.dispose()
  })

  it('asks again when the device is back online after a read that could not get through', async () => {
    const net = link(false)
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([record('msg-1', { status: 'confirmed' })])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      lookupRecords: lookup,
      connection: net.port,
      initialPending: [seeded('msg-1', 'sent')],
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    controller.start()
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
    expect(states(controller)).toEqual(['msg-1:sent'])
    net.set(true)
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(controller.getSnapshot().bubbles).toEqual([]))
    controller.dispose()
  })

  it('keeps going when the read cannot even start (a client without the procedure)', () => {
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: transcript().port,
      records: records().port,
      lookupRecords: () => {
        throw new TypeError('messages.records is not a function')
      },
      initialPending: [seeded('msg-1', 'sent')],
      createDeliveryId: () => 'msg-new',
      deliver: vi.fn(),
    })
    expect(() => controller.start()).not.toThrow()
    expect(states(controller)).toEqual(['msg-1:sent'])
    controller.dispose()
  })
})

describe('composer draft work', () => {
  it('keeps 60 keys out of conversation projections and surface publications', () => {
    const feed = transcript()
    const synced = records([record('held')])
    const controller = createSendsFixture({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      records: synced.port,
      createDeliveryId: () => 'msg-typing',
      deliver: async () => ({ state: 'sent' }),
      onDraftChange: vi.fn(),
    })
    controller.start()
    const readTranscript = vi.spyOn(feed.port, 'getSnapshot')
    const readRecords = vi.spyOn(synced.port, 'getSnapshot')
    const surfaceChanged = vi.fn(),
      draftChanged = vi.fn()
    const stopSurface = controller.subscribeSurface(surfaceChanged)
    const stopDraft = controller.subscribe(draftChanged)
    const surface = controller.getSurfaceSnapshot(),
      bubbles = controller.getSnapshot().bubbles
    for (let i = 1; i <= 60; i++) {
      controller.setDraft('x'.repeat(i))
      expect(controller.getSnapshot().draft).toBe('x'.repeat(i))
      expect(controller.getSnapshot().bubbles).toBe(bubbles)
      expect(controller.getSurfaceSnapshot()).toBe(surface)
    }
    expect(draftChanged).toHaveBeenCalledTimes(60)
    expect(surfaceChanged).not.toHaveBeenCalled()
    expect(readTranscript).not.toHaveBeenCalled()
    expect(readRecords).not.toHaveBeenCalled()
    controller.replaceDraft('remote draft')
    expect(controller.getSnapshot().draft).toBe('remote draft')
    expect(surfaceChanged).not.toHaveBeenCalled()
    synced.set([record('held', { status: 'typed' })])
    expect(surfaceChanged).toHaveBeenCalledTimes(1)
    expect(controller.getSurfaceSnapshot()).not.toBe(surface)
    stopSurface()
    stopDraft()
    controller.dispose()
  })
})
