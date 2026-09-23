import { asSessionId, type TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptController,
  mergeTranscriptFrame,
  TRANSCRIPT_ACTIVITY_SETTLE_MS,
  TRANSCRIPT_LIVE_HEARTBEAT_MS,
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
  it('hydrates cache, reads, pages, replaces a same-id record, and writes through', async () => {
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
      subscriptionHealthy: false,
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
    expect(controller.getSnapshot().subscriptionHealthy).toBe(true)
    expect(io.port.subscribe).toHaveBeenCalledWith(asSessionId('s1'), 'c2', expect.any(Function))

    io.emit([item('tail', 'c2-updated', 'complete')])
    expect(controller.getSnapshot().items.map((entry) => entry.text)).toEqual(['a', 'complete'])

    const paging = controller.loadOlder()
    expect(io.reads[1]).toMatchObject({ anchor: 'c1', limit: pageLimit })
    io.pending[1]?.resolve({
      items: [item('older', 'c0'), item('a', 'c1-history')],
      head: 'c0',
      tail: 'c1',
      hasMore: false,
    })
    await paging
    expect(controller.getSnapshot().items.map((entry) => entry.cursor)).toEqual([
      'c0',
      'c1',
      'c2-updated',
    ])
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
  it('restarts cleanly after an adapter effect releases its resources', async () => {
    const io = source()
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: io.port,
    })

    const rehearsed = controller.start()
    controller.stop()
    const mounted = controller.start()
    expect(io.reads).toHaveLength(2)

    io.pending[0]?.resolve({
      items: [item('stale', 'c1')],
      head: 'c1',
      tail: 'c1',
      hasMore: false,
    })
    io.pending[1]?.resolve({
      items: [item('mounted', 'c2')],
      head: 'c2',
      tail: 'c2',
      hasMore: false,
    })
    await Promise.all([rehearsed, mounted])

    expect(controller.getSnapshot()).toMatchObject({
      items: [item('mounted', 'c2')],
      initialLoaded: true,
    })
    expect(io.port.subscribe).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

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
    expect(io.port.subscribe).toHaveBeenCalledTimes(1)

    const changed = controller.probe({ disclose: true })
    expect(controller.getSnapshot().freshness).toBe('checking')
    io.pending[2]?.resolve({ items: [item('b', 'c2')], head: 'c2', tail: 'c2', hasMore: false })
    await Promise.resolve()
    expect(io.reads[3]).toMatchObject({ limit: 200 })
    io.pending[3]?.resolve({ items: [item('b', 'c2')], head: 'c2', tail: 'c2', hasMore: false })
    expect(await changed).toBe(true)
    expect(controller.getSnapshot().items).toEqual([item('b', 'c2')])
    expect(io.port.subscribe).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('orders replayed cursors and replaces repeated ids', () => {
    const held = [item('answer', 'WyJmIiw5MDAsbnVsbCwwXQ', 'answer')]
    const merged = mergeTranscriptFrame(held, [
      item('prompt', 'WyJmIiwxMDAsbnVsbCwwXQ', 'prompt'),
      item('answer', 'WyJmIiw5MDAsbnVsbCwwXQ', 'answer complete'),
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
    expect(controller.getSnapshot().subscriptionHealthy).toBe(false)
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


describe('history paging and reset boundaries', () => {
  it('uses page cursors for paging and native item cursors for stream catch-up', async () => {
    const io = source()
    const controller = createTranscriptController({ sessionId: asSessionId('s1'), source: io.port })
    const starting = controller.start()
    io.pending[0]?.resolve({ items: [item('new', 'native-new')], head: 'history-new', tail: 'history-tail', hasMore: true })
    await starting
    expect(io.port.subscribe).toHaveBeenCalledWith(asSessionId('s1'), 'native-new', expect.any(Function))
    const first = controller.loadOlder()
    expect(io.reads[1]?.anchor).toBe('history-new')
    io.pending[1]?.resolve({ items: [item('older', 'native-old')], head: 'history-old', tail: 'history-old', hasMore: true })
    await first
    const second = controller.loadOlder()
    expect(io.reads[2]?.anchor).toBe('history-old')
    io.pending[2]?.resolve({ items: [], hasMore: false })
    await second
    controller.dispose()
  })

  it('an empty reset removes held rows and saved rows even when refresh fails', async () => {
    const io = source()
    const write = vi.fn()
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'), source: io.port,
      cache: { read: () => undefined, write },
    })
    const starting = controller.start()
    io.pending[0]?.resolve({ items: [item('stale', 'native-old')], hasMore: false })
    await starting
    io.emit([], true)
    expect(controller.getSnapshot().items).toEqual([])
    expect(write).toHaveBeenLastCalledWith(asSessionId('s1'), [])
    io.pending[1]?.reject(new Error('offline'))
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().items).toEqual([])
    controller.dispose()
  })
})


it('replaces a live window when paging switches to archive history', async () => {
  const io = source()
  const controller = createTranscriptController({ sessionId: asSessionId('s1'), source: io.port })
  const starting = controller.start()
  io.pending[0]?.resolve({ items: [item('live', 'native-live')], head: 'runtime-history:head', hasMore: true })
  await starting
  const older = controller.loadOlder()
  io.pending[1]?.resolve({ reset: true, items: [item('archived', 'archive-item')], head: 'archive-head', tail: 'archive-tail', hasMore: true })
  await older
  expect(controller.getSnapshot()).toMatchObject({
    items: [item('archived', 'archive-item')], head: 'archive-head', hasMoreOlder: true,
  })
  controller.dispose()
})

/**
 * An authority that answers every read from what the agent has written so far,
 * over a live stream that delivers NOTHING — the acceptance run's phone after a
 * daemon restart, where the server never forwarded the turn's answer.
 */
function silentStreamAuthority(initial: TranscriptItem[]) {
  const written = [...initial]
  const reads: TranscriptReadRequest[] = []
  return {
    written,
    reads,
    port: {
      async read(request: TranscriptReadRequest): Promise<TranscriptPage> {
        reads.push(request)
        const end = request.anchor
          ? written.findIndex((entry) => entry.cursor === request.anchor)
          : written.length
        const start = Math.max(0, end - request.limit)
        const items = written.slice(start, end)
        return { items, head: items[0]?.cursor, tail: items.at(-1)?.cursor, hasMore: start > 0 }
      },
      subscribe: () => () => {},
    },
  }
}

describe('a live window that the stream stopped feeding heals itself (POD-4643)', () => {
  const question = item('q', 'c2', 'What is 7 times 7?')
  const answer = item('answer', 'c3', '49 LEMON')

  async function started(options: { visible?: () => boolean; initial?: TranscriptItem[] } = {}) {
    vi.useFakeTimers()
    const authority = silentStreamAuthority(options.initial ?? [item('a', 'c1'), question])
    const controller = createTranscriptController({
      sessionId: asSessionId('s1'),
      source: authority.port,
      initialLimit: 2,
      pageLimit: 2,
      ...(options.visible ? { visible: options.visible } : {}),
    })
    controller.observeActivity({ signal: 'row-1', live: true })
    await controller.start()
    return { authority, controller }
  }

  function ids(controller: ReturnType<typeof createTranscriptController>) {
    return controller.getSnapshot().items.map((entry) => entry.id)
  }

  it('re-reads once the session row moves and the stream said nothing', async () => {
    const { authority, controller } = await started({ visible: () => false })
    try {
      authority.written.push(answer)
      controller.observeActivity({ signal: 'row-2', live: false })
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_ACTIVITY_SETTLE_MS - 1)
      expect(ids(controller)).not.toContain('answer')
      await vi.advanceTimersByTimeAsync(1)
      expect(ids(controller)).toContain('answer')
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })

  it('a live session is probed on a heartbeat even when the row does not move', async () => {
    const { authority, controller } = await started()
    try {
      authority.written.push(answer)
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_LIVE_HEARTBEAT_MS)
      expect(ids(controller)).toContain('answer')
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })

  it('an unchanged row and a current window cost nothing', async () => {
    const { authority, controller } = await started()
    try {
      const readsAfterStart = authority.reads.length
      controller.observeActivity({ signal: 'row-1', live: false })
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_LIVE_HEARTBEAT_MS * 3)
      expect(authority.reads).toHaveLength(readsAfterStart)
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })

  it('a heartbeat on an equal tail reads one item and keeps the window', async () => {
    const { authority, controller } = await started()
    try {
      const before = controller.getSnapshot().items
      const readsAfterStart = authority.reads.length
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_LIVE_HEARTBEAT_MS)
      expect(authority.reads.slice(readsAfterStart)).toEqual([
        expect.objectContaining({ limit: 1 }),
      ])
      expect(controller.getSnapshot().items).toBe(before)
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })

  it('a hidden reader is not probed', async () => {
    const { authority, controller } = await started({ visible: () => false })
    try {
      authority.written.push(answer)
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_LIVE_HEARTBEAT_MS * 2)
      expect(ids(controller)).not.toContain('answer')
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })

  it('stands down while the reader has older pages loaded, and keeps them', async () => {
    const { authority, controller } = await started({
      initial: [item('old', 'c0'), item('a', 'c1'), question],
    })
    try {
      expect(await controller.loadOlder()).toBe(true)
      expect(ids(controller)).toEqual(['old', 'a', 'q'])
      authority.written.push(answer)
      controller.observeActivity({ signal: 'row-2', live: true })
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_LIVE_HEARTBEAT_MS * 2)
      expect(ids(controller)).toEqual(['old', 'a', 'q'])
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })

  it('a stopped controller schedules nothing', async () => {
    const { authority, controller } = await started()
    try {
      controller.stop()
      const readsAtStop = authority.reads.length
      controller.observeActivity({ signal: 'row-2', live: true })
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_LIVE_HEARTBEAT_MS * 2)
      expect(authority.reads).toHaveLength(readsAtStop)
    } finally {
      controller.dispose()
      vi.useRealTimers()
    }
  })
})

it('a host that starts the controller before reporting the row pays no second read (POD-4643)', async () => {
  vi.useFakeTimers()
  const authority = silentStreamAuthority([item('a', 'c1')])
  const controller = createTranscriptController({ sessionId: asSessionId('s1'), source: authority.port })
  try {
    const starting = controller.start()
    controller.observeActivity({ signal: 'row-1', live: false })
    await starting
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_ACTIVITY_SETTLE_MS * 5)
    expect(authority.reads).toHaveLength(1)
  } finally {
    controller.dispose()
    vi.useRealTimers()
  }
})
