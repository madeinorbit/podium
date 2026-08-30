import { asSessionId, type SessionOffer, type TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createConversationController } from './controller'

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
})
