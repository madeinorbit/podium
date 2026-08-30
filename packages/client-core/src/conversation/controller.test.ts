import { asSessionId, type SessionOffer, type TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createConversationController } from './controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function transcript() {
  let items: TranscriptItem[] = []
  const listeners = new Set<() => void>()
  return {
    port: {
      getSnapshot: () => ({ items }),
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set(next: TranscriptItem[]) {
      items = next
      for (const listener of listeners) listener()
    },
  }
}

function user(id: string, text: string, extras: Partial<TranscriptItem> = {}): TranscriptItem {
  return { id, role: 'user', text, ...extras }
}

function offer(createdAt = '2026-08-30T12:00:00.000Z'): SessionOffer {
  return { message: 'Choose', actions: [{ label: 'Do it', prompt: 'do it' }], createdAt }
}

describe('conversation controller contract', () => {
  it('owns a controlled draft, exact-wire retry, offer restoration, and echo reconciliation', async () => {
    const feed = transcript()
    const drafts: string[] = []
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error('not sent'))
      .mockResolvedValueOnce({ state: 'queued' })
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      initialDraft: 'remembered',
      onDraftChange: (text) => drafts.push(text),
      createDeliveryId: () => 'msg-1',
      deliver,
      dismissOffer: vi.fn(async () => {}),
    })
    await controller.start()
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
    feed.set([user('echo', 'look', { toolPaths: ['/uploads/shot.png'] })])
    expect(controller.getSnapshot().pending).toEqual([])
    controller.dispose()
  })

  it('projects durable queue identity and retracts it optimistically', async () => {
    const feed = transcript()
    const retract = vi.fn(async () => {})
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'queued' }),
      readQueue: async () => [
        {
          id: 'msg-1',
          from: 'operator',
          to: 'session:s1',
          status: 'queued',
          body: 'hello',
          createdAt: '2026-08-30T12:00:00.000Z',
          injectedAt: null,
        },
      ],
      retract,
    })
    await controller.start()
    await controller.submit({ text: 'hello' })
    await controller.refreshQueue()
    expect(controller.getSnapshot().projected.pending[0]?.durable?.id).toBe('msg-1')
    await controller.retract('msg-1')
    expect(retract).toHaveBeenCalledWith('msg-1')
    expect(controller.getSnapshot().pending).toEqual([])
    expect(controller.getSnapshot().queued).toEqual([])
    controller.dispose()
  })

  it('restores a durable row when retraction is refused', async () => {
    const feed = transcript()
    const row = {
      id: 'queued-1',
      from: 'operator',
      to: 'session:s1',
      status: 'queued',
      body: 'keep me',
      createdAt: '2026-08-30T12:00:00.000Z',
    }
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: vi.fn(),
      readQueue: async () => [row],
      retract: vi.fn(async () => {
        throw new Error('already injected')
      }),
    })
    await controller.start()
    await expect(controller.retract('queued-1')).rejects.toThrow('already injected')
    expect(controller.getSnapshot().queued.map((message) => message.id)).toEqual(['queued-1'])
    controller.dispose()
  })

  it('keys optimistic offer state by createdAt so a replacement remains visible', async () => {
    const feed = transcript()
    let reject!: (cause: unknown) => void
    const delivered = new Promise<void>((_resolve, no) => {
      reject = no
    })
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: () => delivered,
    })
    await controller.start()
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
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: vi.fn(),
      interrupt,
    })
    await controller.start()
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
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'queued' }),
      interrupt,
    })
    await controller.start()
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

  it('rejects an older queue read after a newer snapshot lands', async () => {
    const feed = transcript()
    const reads: Array<ReturnType<typeof deferred<unknown>>> = []
    const readQueue = vi.fn(() => {
      const next = deferred<unknown>()
      reads.push(next)
      return next.promise
    })
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: vi.fn(),
      readQueue,
    })
    const starting = controller.start()
    reads[0]?.resolve([])
    await starting

    const older = controller.refreshQueue()
    const newer = controller.refreshQueue()
    reads[2]?.resolve([
      {
        id: 'new',
        from: 'operator',
        to: 'session:s1',
        status: 'queued',
        body: 'newer',
        createdAt: '2026-08-30T12:00:02.000Z',
      },
    ])
    await newer
    reads[1]?.resolve([
      {
        id: 'old',
        from: 'operator',
        to: 'session:s1',
        status: 'queued',
        body: 'older',
        createdAt: '2026-08-30T12:00:01.000Z',
      },
    ])
    await older
    expect(controller.getSnapshot().queued.map((message) => message.id)).toEqual(['new'])
    controller.dispose()
  })

  it('does not let a pre-retract queue read resurrect the cancelled row', async () => {
    const feed = transcript()
    const stale = deferred<unknown>()
    const row = {
      id: 'queued-1',
      from: 'operator',
      to: 'session:s1',
      status: 'queued',
      body: 'later',
      createdAt: '2026-08-30T12:00:00.000Z',
    }
    const readQueue = vi.fn().mockResolvedValueOnce([row]).mockReturnValueOnce(stale.promise)
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: vi.fn(),
      readQueue,
      retract: vi.fn(async () => {}),
    })
    await controller.start()
    const reading = controller.refreshQueue()
    await controller.retract('queued-1')
    stale.resolve([row])
    await reading
    expect(controller.getSnapshot().queued).toEqual([])
    controller.dispose()
  })

  it('removes a row returned by a poll that began while retract was committing', async () => {
    const feed = transcript()
    const cancel = deferred<void>()
    const stale = deferred<unknown>()
    const row = {
      id: 'queued-1',
      from: 'operator',
      to: 'session:s1',
      status: 'queued',
      body: 'later',
      createdAt: '2026-08-30T12:00:00.000Z',
    }
    const readQueue = vi.fn().mockResolvedValueOnce([row]).mockReturnValueOnce(stale.promise)
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: vi.fn(),
      readQueue,
      retract: () => cancel.promise,
    })
    await controller.start()
    const retracting = controller.retract('queued-1')
    const reading = controller.refreshQueue()
    stale.resolve([row])
    await reading
    expect(controller.getSnapshot().queued).toEqual([])
    cancel.resolve()
    await retracting
    expect(controller.getSnapshot().queued).toEqual([])
    controller.dispose()
  })

  it('pauses and resumes fast acknowledgement polling with activation', async () => {
    vi.useFakeTimers()
    const feed = transcript()
    const readQueue = vi.fn(async () => [])
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      createDeliveryId: () => 'msg-1',
      deliver: async () => ({ state: 'queued' }),
      readQueue,
      queueRefreshMs: 5_000,
      queuedAckRefreshMs: 1_000,
    })
    try {
      await controller.start()
      controller.setActive(false)
      await controller.submit({ text: 'wait' })
      await Promise.resolve()
      const inactiveReads = readQueue.mock.calls.length
      await vi.advanceTimersByTimeAsync(2_000)
      expect(readQueue).toHaveBeenCalledTimes(inactiveReads)

      controller.setActive(true)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(readQueue.mock.calls.length).toBeGreaterThan(inactiveReads)

      controller.setActive(false)
      const pausedReads = readQueue.mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(readQueue).toHaveBeenCalledTimes(pausedReads)
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })
})

describe.each([
  { client: 'desktop', queueRefreshMs: 5_000, queuedAckRefreshMs: 1_000 },
  { client: 'ios', queueRefreshMs: 5_000, queuedAckRefreshMs: 1_000 },
] as const)('$client conversation parity', ({ client, queueRefreshMs, queuedAckRefreshMs }) => {
  it('runs the same controlled-draft, durable-id, offer, retry, and retract contract', async () => {
    const feed = transcript()
    const deliveryId = `msg-${client}`
    const deliver = vi.fn().mockRejectedValueOnce(new Error('retry')).mockResolvedValueOnce({
      state: 'queued',
    })
    const retract = vi.fn(async () => {})
    const controller = createConversationController({
      sessionId: asSessionId('s1'),
      transcript: feed.port,
      initialDraft: 'draft',
      createDeliveryId: () => deliveryId,
      deliver,
      dismissOffer: vi.fn(async () => {}),
      readQueue: async () => [
        {
          id: deliveryId,
          from: 'operator',
          to: 'session:s1',
          status: 'queued',
          body: 'ship',
          createdAt: new Date(Date.now()).toISOString(),
        },
      ],
      retract,
      queueRefreshMs,
      queuedAckRefreshMs,
    })
    await controller.start()
    controller.updateContext({ canInterrupt: false, offer: offer() })
    await controller.dismissOffer(offer().createdAt)
    await controller.submit({ text: 'ship' })
    await controller.retry('pending-1')
    await controller.refreshQueue()
    expect(controller.getSnapshot()).toMatchObject({
      draft: '',
      offer: null,
      projected: { pending: [expect.objectContaining({ durable: { id: deliveryId } })] },
    })
    await controller.retract(deliveryId)
    expect(controller.getSnapshot().projected).toEqual({ pending: [], queued: [] })
    controller.dispose()
  })
})
