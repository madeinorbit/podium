import { asSessionId, type TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptController,
  mergeTranscriptFrame,
  type TranscriptPage,
  type TranscriptReadRequest,
} from './controller'

function item(id: string, cursor: string, text = id): TranscriptItem {
  return { id, cursor, role: 'assistant', text }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function source() {
  const reads: TranscriptReadRequest[] = []
  const pending: Array<ReturnType<typeof deferred<TranscriptPage>>> = []
  let subscriber: ((items: TranscriptItem[], meta: { reset: boolean }) => void) | undefined
  const subscribe = vi.fn(
    (
      _sessionId: ReturnType<typeof asSessionId>,
      _since: string | undefined,
      listener: (items: TranscriptItem[], meta: { reset: boolean }) => void,
    ) => {
      subscriber = listener
      return () => {
        if (subscriber === listener) subscriber = undefined
      }
    },
  )
  return {
    reads,
    pending,
    port: {
      read(request: TranscriptReadRequest) {
        reads.push(request)
        const next = deferred<TranscriptPage>()
        pending.push(next)
        return next.promise
      },
      subscribe,
    },
    emit(items: TranscriptItem[], reset = false) {
      subscriber?.(items, { reset })
    },
  }
}

const clients = [
  { name: 'desktop', initialLimit: 200, pageLimit: 400 },
  { name: 'ios', initialLimit: 80, pageLimit: 80 },
] as const

describe.each(clients)('$name transcript contract', ({ initialLimit, pageLimit }) => {
  it('hydrates cache, reads, pages, replaces a same-cursor record, and writes through', async () => {
    const io = source()
    const write = vi.fn()
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
      initialLimit,
      pageLimit,
      cache: {
        read: () => ({ items: [item('cached', 'c1', 'saved')], savedAt: 10 }),
        write,
      },
    })

    const starting = controller.start()
    expect(controller.getSnapshot()).toMatchObject({
      items: [item('cached', 'c1', 'saved')],
      freshness: 'checking',
      initialLoaded: false,
    })
    expect(io.reads[0]).toMatchObject({ limit: initialLimit })
    io.pending[0]?.resolve({
      items: [item('a', 'c1'), item('tail', 'c2', 'partial')],
      head: 'c1',
      tail: 'c2',
      hasMore: true,
    })
    await starting
    expect(io.port.subscribe).toHaveBeenCalledWith(asSessionId('s1'), 'c2', expect.any(Function))

    io.emit([item('tail-complete', 'c2', 'complete')])
    expect(controller.getSnapshot().items.map((entry) => entry.text)).toEqual(['a', 'complete'])

    const paging = controller.loadOlder()
    expect(io.reads[1]).toMatchObject({ anchor: 'c1', limit: pageLimit })
    io.pending[1]?.resolve({
      items: [item('older', 'c0'), item('a-copy', 'c1')],
      head: 'c0',
      tail: 'c1',
      hasMore: false,
    })
    await paging
    expect(controller.getSnapshot().items.map((entry) => entry.cursor)).toEqual(['c0', 'c1', 'c2'])
    expect(write).toHaveBeenCalled()
    controller.dispose()
  })

  it('rejects an older page after a newest-window replacement', async () => {
    const io = source()
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
      initialLimit,
      pageLimit,
    })
    const starting = controller.start()
    io.pending[0]?.resolve({ items: [item('a', 'c2')], head: 'c2', tail: 'c2', hasMore: true })
    await starting

    const older = controller.loadOlder()
    const refresh = controller.refresh()
    io.pending[2]?.resolve({ items: [item('new', 'c9')], head: 'c9', tail: 'c9', hasMore: false })
    await refresh
    io.pending[1]?.resolve({ items: [item('stale', 'c1')], head: 'c1', tail: 'c1', hasMore: false })
    expect(await older).toBe(false)
    expect(controller.getSnapshot().items).toEqual([item('new', 'c9')])
    controller.dispose()
  })
})

describe('transcript lifecycle boundaries', () => {
  it('refreshes on reconnect and drops the pre-reconnect result', async () => {
    const io = source()
    let connected = false
    let connectionListener: ((next: boolean) => void) | undefined
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
      connection: {
        connected: () => connected,
        subscribe(listener) {
          connectionListener = listener
          return () => {
            connectionListener = undefined
          }
        },
      },
    })
    const starting = controller.start()
    connected = true
    connectionListener?.(true)
    io.pending[1]?.resolve({ items: [item('fresh', 'c2')], head: 'c2', tail: 'c2', hasMore: false })
    await Promise.resolve()
    io.pending[0]?.resolve({ items: [item('stale', 'c1')], head: 'c1', tail: 'c1', hasMore: false })
    await starting
    expect(controller.getSnapshot().items).toEqual([item('fresh', 'c2')])
    controller.dispose()
  })

  it('ignores a stale initial failure after reconnect succeeds', async () => {
    const io = source()
    let connected = false
    let connectionListener: ((next: boolean) => void) | undefined
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
      cache: { read: () => ({ items: [item('saved', 'c0')], savedAt: 42 }), write: vi.fn() },
      connection: {
        connected: () => connected,
        subscribe(listener) {
          connectionListener = listener
          return () => {
            connectionListener = undefined
          }
        },
      },
    })
    const starting = controller.start()
    connected = true
    connectionListener?.(true)
    io.pending[1]?.resolve({
      items: [item('fresh', 'c2')],
      head: 'c2',
      tail: 'c2',
      hasMore: true,
    })
    await Promise.resolve()
    io.pending[0]?.reject(new Error('stale offline failure'))
    await starting
    expect(controller.getSnapshot()).toMatchObject({
      items: [item('fresh', 'c2')],
      hasMoreOlder: true,
      offlineAsOf: null,
    })
    expect(io.port.subscribe).toHaveBeenLastCalledWith(
      asSessionId('s1'),
      'c2',
      expect.any(Function),
    )
    controller.dispose()
  })

  it('keeps a cached window and marks it saved when the read fails', async () => {
    const io = source()
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
      cache: { read: () => ({ items: [item('a', 'c1')], savedAt: 42 }), write: vi.fn() },
    })
    const starting = controller.start()
    io.pending[0]?.reject(new Error('offline'))
    await starting
    expect(controller.getSnapshot()).toMatchObject({
      items: [item('a', 'c1')],
      initialLoaded: true,
      freshness: 'saved',
      offlineAsOf: 42,
    })
    controller.dispose()
  })

  it('keeps an equal tail probe cheap and escalates a changed tail to refresh', async () => {
    const io = source()
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
    })
    const starting = controller.start()
    io.pending[0]?.resolve({ items: [item('a', 'c1')], head: 'c1', tail: 'c1', hasMore: false })
    await starting

    const equal = controller.probe()
    io.pending[1]?.resolve({ items: [item('a', 'c1')], head: 'c1', tail: 'c1', hasMore: false })
    expect(await equal).toBe(true)
    expect(io.reads).toHaveLength(2)

    const changed = controller.probe()
    io.pending[2]?.resolve({ items: [item('b', 'c2')], head: 'c2', tail: 'c2', hasMore: false })
    await Promise.resolve()
    expect(io.reads[3]).toMatchObject({ limit: 200 })
    io.pending[3]?.resolve({ items: [item('b', 'c2')], head: 'c2', tail: 'c2', hasMore: false })
    expect(await changed).toBe(true)
    expect(controller.getSnapshot().items).toEqual([item('b', 'c2')])
    controller.dispose()
  })

  it('orders replayed cursors and replaces repeated cursors', () => {
    const held = [item('answer', 'WyJmIiw5MDAsbnVsbCwwXQ', 'answer')]
    const merged = mergeTranscriptFrame(held, [
      item('prompt', 'WyJmIiwxMDAsbnVsbCwwXQ', 'prompt'),
      item('answer-complete', 'WyJmIiw5MDAsbnVsbCwwXQ', 'answer complete'),
    ])
    expect(merged.map((entry) => entry.text)).toEqual(['prompt', 'answer complete'])
  })

  it('invalidates an in-flight read when a reset starts its replacement', async () => {
    const io = source()
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
    })
    const starting = controller.start()
    io.pending[0]?.resolve({ items: [item('a', 'c1')], head: 'c1', tail: 'c1', hasMore: false })
    await starting

    const stale = controller.refresh({ disclose: true })
    io.emit([], true)
    io.pending[2]?.resolve({ items: [item('fresh', 'c3')], head: 'c3', tail: 'c3', hasMore: false })
    await Promise.resolve()
    io.pending[1]?.resolve({ items: [item('stale', 'c2')], head: 'c2', tail: 'c2', hasMore: false })
    expect(await stale).toBe(false)
    await Promise.resolve()
    expect(controller.getSnapshot().items).toEqual([item('fresh', 'c3')])
    controller.dispose()
  })

  it('keeps cache freshness visible until the consumer marks the new graph rendered', async () => {
    const io = source()
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
      cache: { read: () => ({ items: [item('saved', 'c1')], savedAt: 42 }), write: vi.fn() },
    })
    const starting = controller.start()
    expect(controller.getSnapshot().freshness).toBe('checking')
    io.pending[0]?.resolve({
      items: [item('fresh', 'c2')],
      head: 'c2',
      tail: 'c2',
      hasMore: false,
    })
    await starting
    expect(controller.getSnapshot().freshness).toBe('rendering')
    controller.markRendered()
    expect(controller.getSnapshot().freshness).toBeNull()
    controller.dispose()
  })
})
