import { asSessionId, type TranscriptItem } from '@podium/model'
import type { TurnPreviewMessage } from '@podium/protocol'
import { autorun, observable, runInAction, spy } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SocketHub } from '../socket-transport/socket-hub'
import {
  Conversation,
  TURN_PREVIEW_STALE_MS,
  type ConversationOptions,
  type ConversationSession,
} from './model'
import { DraftStore } from './draft-store'

const sid = asSessionId('session')
const row = (id: string, text = id): TranscriptItem => ({
  id,
  cursor: `c-${id}`,
  role: 'assistant',
  text,
})
const preview = (turnEpoch: number, seq: number, text = `${seq}`): TurnPreviewMessage => ({
  type: 'turnPreview',
  sessionId: sid,
  turnEpoch,
  seq,
  items: [{ kind: 'text', itemId: 'stream', text }],
})

function fixture(over: Partial<ConversationOptions> = {}) {
  const handlers = new Map<string, Set<(...args: any[]) => void>>()
  const hub = {
    on(kind: string, listener: (...args: any[]) => void) {
      const listeners = handlers.get(kind) ?? new Set()
      listeners.add(listener)
      handlers.set(kind, listeners)
      return () => listeners.delete(listener)
    },
  } as Pick<SocketHub, 'on'>
  const frames: (() => void)[] = [],
    tasks: (() => void)[] = []
  let intake: ((items: TranscriptItem[], meta: { reset: boolean }) => void) | undefined
  const drafts = new DraftStore({
    storage: { get: () => null, set: vi.fn() },
    hub: {
      ...hub,
      sendDraftEdit: vi.fn(),
      connectionHealth: () => ({ status: 'ok', rttMs: null, since: 0 }),
    },
  })
  const current = observable.box<ConversationSession>(
    { status: 'exited', agentState: { phase: 'idle', since: 'initial' } },
    { deep: false },
  )
  const read = vi.fn(async () => ({ items: [row('a')], hasMore: false }))
  const source = {
    read,
    subscribe: vi.fn((_id, _since, listener) => {
      intake = listener
      return () => {
        intake = undefined
      }
    }),
  } satisfies ConversationOptions['transcript']['source']
  const conversation = new Conversation({
    sessionId: sid,
    drafts,
    hub,
    readSession: () => current.get(),
    transcript: { source },
    sends: {
      createDeliveryId: () => 'delivery',
      deliver: vi.fn(async () => ({ state: 'sent' as const })),
    },
    scheduler: {
      visible: () => true,
      requestFrame: (cb) => {
        frames.push(cb)
        return frames.length
      },
      cancelFrame: vi.fn(),
      tasks: {
        schedule: (cb) => tasks.push(cb),
        dispose: () => {
          tasks.length = 0
        },
      },
    },
    ...over,
  })
  const emit = (kind: string, ...args: unknown[]) => {
    for (const listener of handlers.get(kind) ?? []) listener(...args)
  }
  return {
    conversation,
    drafts,
    read,
    source,
    current,
    frames,
    tasks,
    emit,
    delta: (items: TranscriptItem[], reset = false) => intake?.(items, { reset }),
    paint: () => frames.shift()?.(),
    subscriptions: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
    dispose: () => {
      conversation.dispose()
      drafts.dispose()
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('Conversation real-time intake and ownership', () => {
  it('publishes two deltas and a preview in one frame action, without waking the ids list', async () => {
    const f = fixture()
    await f.conversation.start()
    const ids = vi.fn(),
      content = vi.fn(),
      previews = vi.fn()
    const stopIds = autorun(() => {
      f.conversation.transcript.ids.slice()
      ids()
    })
    const stopRow = autorun(() => {
      f.conversation.transcript.byId.get('a')
      content()
    })
    const stopPreview = autorun(() => {
      f.conversation.preview
      previews()
    })
    ids.mockClear()
    content.mockClear()
    previews.mockClear()
    const actions: string[] = []
    const stopSpy = spy((event) => {
      if (event.type === 'action' && event.name === 'Conversation.applyFrame')
        actions.push(event.name)
    })
    f.delta([row('a', 'partial')])
    f.delta([row('a', 'complete')])
    f.emit('turnPreview', sid, preview(1, 2))
    expect(f.frames).toHaveLength(1)
    expect(f.conversation.transcript.byId.get('a')?.text).toBe('a')
    f.paint()
    expect(actions).toHaveLength(1)
    expect(ids).not.toHaveBeenCalled()
    expect(content).toHaveBeenCalledTimes(1)
    expect(previews).toHaveBeenCalledTimes(1)
    expect(f.conversation.transcript.byId.get('a')?.text).toBe('complete')
    stopSpy()
    stopIds()
    stopRow()
    stopPreview()
    f.dispose()
  })

  it('a preview frame changes only preview', async () => {
    const f = fixture()
    await f.conversation.start()
    const notify = vi.fn()
    const stop = autorun(() => {
      const log = f.conversation.transcript
      log.ids.slice()
      log.byId.get('a')
      log.freshness
      log.tail
      f.conversation.sends.pending.slice()
      f.conversation.sends.bubbles
      f.conversation.headless
      notify()
    })
    notify.mockClear()
    f.emit('turnPreview', sid, preview(1, 1))
    f.paint()
    expect(notify).not.toHaveBeenCalled()
    expect(f.conversation.preview?.items).toEqual(preview(1, 1).items)
    stop()
    f.dispose()
  })

  it('hidden documents apply through a real MessageChannel without requesting a paint', async () => {
    const requestFrame = vi.fn()
    const f = fixture({ scheduler: { visible: () => false, requestFrame } })
    await f.conversation.start()
    const applied = new Promise<void>((resolve) => {
      const stop = autorun(() => {
        if (f.conversation.transcript.byId.get('a')?.text !== 'hidden') return
        queueMicrotask(() => {
          stop()
          resolve()
        })
      })
    })
    f.delta([row('a', 'hidden')])
    await applied
    expect(requestFrame).not.toHaveBeenCalled()
    f.dispose()
  })

  it('switches a pending visible frame to a hidden macrotask', async () => {
    let visible = true,
      changed!: () => void
    const frames: (() => void)[] = [],
      tasks: (() => void)[] = []
    const cancel = vi.fn()
    const f = fixture({
      scheduler: {
        visible: () => visible,
        requestFrame: (cb) => {
          frames.push(cb)
          return 7
        },
        cancelFrame: cancel,
        onVisibilityChange: (cb) => {
          changed = cb
          return vi.fn()
        },
        tasks: { schedule: (cb) => tasks.push(cb), dispose: vi.fn() },
      },
    })
    await f.conversation.start()
    f.delta([row('a', 'current')])
    visible = false
    changed()
    expect(cancel).toHaveBeenCalledWith(7)
    expect(tasks).toHaveLength(1)
    tasks.shift()!()
    frames.shift()!()
    expect(f.conversation.transcript.byId.get('a')?.text).toBe('current')
    f.dispose()
  })

  it('orders previews, fences done epochs, and clears disconnected queued work', async () => {
    const listeners = new Set<(connected: boolean) => void>()
    const f = fixture({
      connection: {
        connected: () => true,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    })
    await f.conversation.start()
    f.emit('turnPreview', sid, preview(2, 3))
    f.emit('turnPreview', sid, preview(2, 2))
    f.emit('turnPreview', sid, { ...preview(1, 5), done: true })
    f.paint()
    expect(f.conversation.preview?.items).toEqual(preview(2, 3).items)
    f.emit('turnPreview', sid, { ...preview(2, 4), done: true })
    f.emit('turnPreview', sid, preview(2, 5))
    f.paint()
    expect(f.conversation.preview).toBeNull()
    f.emit('turnPreview', sid, preview(3, 1))
    for (const listener of listeners) listener(false)
    f.paint()
    expect(f.conversation.preview).toBeNull()
    for (const listener of listeners) listener(true)
    f.emit('turnPreview', sid, preview(1, 1))
    f.paint()
    expect(f.conversation.preview?.turnEpoch).toBe(1)
    f.dispose()
    expect(listeners.size).toBe(0)
  })

  it('expires orphaned previews and clears every subscription and timer on disposal', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.conversation.start()
    f.emit('turnPreview', sid, preview(1, 1))
    f.paint()
    vi.advanceTimersByTime(TURN_PREVIEW_STALE_MS)
    expect(f.conversation.preview).toBeNull()
    f.emit('turnPreview', sid, preview(2, 1))
    f.paint()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    f.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.subscriptions()).toBe(0)
  })

  it('reconciles sends in the same publication as a user item', async () => {
    const f = fixture({
      sends: {
        createDeliveryId: () => 'delivery',
        deliver: async () => ({ state: 'sent' }),
        reconcile: 'next-user-item',
      },
    })
    await f.conversation.start()
    await f.conversation.sends.submit({ text: 'prompt' })
    const observations: { hasItem: boolean; pending: number }[] = []
    const stop = autorun(() =>
      observations.push({
        hasItem: f.conversation.transcript.byId.has('u'),
        pending: f.conversation.sends.pending.length,
      }),
    )
    f.delta([{ id: 'u', cursor: 'c-u', role: 'user', text: 'expanded prompt' }])
    f.paint()
    expect(observations).toEqual([
      { hasItem: false, pending: 1 },
      { hasItem: true, pending: 0 },
    ])
    stop()
    f.dispose()
  })

  it('reacts to row liveness without updateContext pushes', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.conversation.start()
    runInAction(() =>
      f.current.set({
        status: 'live',
        lastActiveAt: 'moved',
        agentState: { phase: 'working', since: 'turn' },
      }),
    )
    expect(f.conversation.status).toBe('live')
    expect(f.conversation.sends.canInterrupt).toBe(true)
    vi.advanceTimersByTime(400)
    await Promise.resolve()
    expect(f.read).toHaveBeenCalledTimes(2)
    f.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves headless text under status, retires it on transcript growth, and reports turn-end errors', async () => {
    const f = fixture({ headless: true })
    await f.conversation.start()
    f.emit('headlessActivity', sid, { kind: 'partial-text', text: 'streamed' })
    f.emit('headlessActivity', sid, { kind: 'status', status: 'tool', label: 'Bash' })
    f.paint()
    expect(f.conversation.headless).toEqual({ text: 'streamed', status: 'running Bash…' })
    expect(f.conversation.sends.canInterrupt).toBe(true)
    f.delta([row('b')])
    f.paint()
    expect(f.conversation.headless).toEqual({ status: 'running Bash…' })
    f.emit('headlessActivity', sid, { kind: 'turn-end', error: 'refused' })
    f.paint()
    expect(f.conversation.headless).toBeNull()
    expect(f.conversation.turnRunning).toBe(false)
    expect(f.conversation.turnError).toBe('refused')
    f.dispose()
  })

  it('seeds cached messages synchronously before starting network work', () => {
    const read = vi.fn(async () => ({ items: [], hasMore: false }))
    const f = fixture({
      transcript: {
        source: { read, subscribe: vi.fn(() => vi.fn()) },
        cache: { read: () => ({ items: [row('cached')], savedAt: 10 }), write: vi.fn() },
      },
    })
    expect(read).not.toHaveBeenCalled()
    expect(f.conversation.transcript.ids.slice()).toEqual(['cached'])
    expect(f.conversation.transcript.byId.get('cached')?.text).toBe('cached')
    f.dispose()
  })
})
