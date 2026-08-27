import { addSink } from '@podium/logger'
import { asMachineId, asSessionId } from '@podium/model'
import {
  CAP_TERMINAL_INPUT_BINARY_V1,
  CAP_TERMINAL_OUTPUT_BINARY_V1,
  ClientPtyInputMetadata,
  decodeBinaryEnvelope,
  encode,
  encodeBinaryEnvelope,
  type ServerMessage,
} from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FEED_DELTA_RESYNC_QUEUE_DEPTH, SocketHub, type WebSocketLike } from './socket-hub'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  error(): void {
    this.onerror?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  recv(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

class BrowserSocket extends FakeSocket {
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  closeCalls = 0
  override close(): void {
    this.closeCalls += 1
  }
  recvBinary(bytes: Uint8Array): void {
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    this.onmessage?.({ data })
  }
}

class BinaryInputSocket extends FakeSocket {
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  binarySent: Uint8Array[] = []
  sendBinary(data: Uint8Array): void {
    this.binarySent.push(data.slice())
  }
}

class NonBinarySocket extends FakeSocket {
  closeCalls = 0
  override close(): void {
    this.closeCalls += 1
  }
}

function setup() {
  const sock = new FakeSocket()
  const hub = new SocketHub({
    url: 'ws://x',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    makeSocket: () => sock,
  })
  return { sock, hub }
}
const b64 = (s: string): string => btoa(s)
const b64Bytes = (...bytes: number[]): string => btoa(String.fromCharCode(...bytes))
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('SocketHub', () => {
  it('sends hello with the viewport on open', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    expect(sock.parsed()).toContainEqual({
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
  })

  it('selects ArrayBuffer mode, advertises binary output, and routes exact bytes', () => {
    const sock = new BrowserSocket()
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
    })
    const frames: Uint8Array[] = []
    hub.attach(asSessionId('s1'), { onFrame: (bytes) => frames.push(bytes) })
    hub.connect()
    expect(sock.binaryType).toBe('arraybuffer')
    sock.open()
    expect(sock.parsed().find((message) => message.type === 'hello')).toMatchObject({
      caps: expect.arrayContaining([CAP_TERMINAL_OUTPUT_BINARY_V1, CAP_TERMINAL_INPUT_BINARY_V1]),
    })

    const payload = Uint8Array.of(0x00, 0xff, 0xe2, 0x82)
    sock.recvBinary(
      encodeBinaryEnvelope(
        { v: 1, type: 'ptyOutput', sessionId: asSessionId('s1'), seq: 4, epoch: 2 },
        payload,
      ),
    )
    expect(frames).toEqual([payload])
    expect(hub.attach(asSessionId('s1')).state()).toMatchObject({ lastSeq: 4, epoch: 2 })
    expect(sock.closeCalls).toBe(0)
  })

  it('advertises binary input and sends exact UTF-8 bytes after welcome acknowledgement', () => {
    const sock = new BinaryInputSocket()
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
    })
    const conn = hub.attach(asSessionId('s1'))
    hub.connect()
    sock.open()
    expect(sock.parsed().find((message) => message.type === 'hello')).toMatchObject({
      caps: expect.arrayContaining([CAP_TERMINAL_INPUT_BINARY_V1]),
    })

    const beforeAck = '\u001b[200~é'
    conn.sendInput(beforeAck)
    expect(sock.binarySent).toHaveLength(0)
    expect(sock.parsed()).toContainEqual({
      type: 'input',
      sessionId: 's1',
      data: b64Bytes(...utf8(beforeAck)),
    })

    // Input acknowledgement is independent of output: this welcome grants only
    // input, yet the client must switch the input path to the binary envelope.
    sock.recv({ type: 'welcome', clientId: 'c0', caps: [CAP_TERMINAL_INPUT_BINARY_V1] })
    const inputs = ['\u0000\u001b[200~é💩', 'paste\nblock', '\r']
    for (const input of inputs) conn.sendInput(input)

    expect(sock.binarySent).toHaveLength(inputs.length)
    const decoded = sock.binarySent.map((frame) =>
      decodeBinaryEnvelope(frame, ClientPtyInputMetadata),
    )
    expect(decoded.map(({ metadata }) => metadata)).toEqual(
      inputs.map(() => ({ v: 1, type: 'ptyInput', sessionId: 's1' })),
    )
    expect(decoded.map(({ payload }) => Array.from(payload))).toEqual(
      inputs.map((input) => Array.from(utf8(input))),
    )
  })

  it('keeps JSON/base64 input when an old server omits the welcome caps', () => {
    const sock = new BinaryInputSocket()
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
    })
    const conn = hub.attach(asSessionId('s1'))
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })

    const input = '\u001b[1;5Dé'
    conn.sendInput(input)
    expect(sock.binarySent).toHaveLength(0)
    expect(sock.parsed()).toContainEqual({
      type: 'input',
      sessionId: 's1',
      data: b64Bytes(...utf8(input)),
    })
  })

  it('drops a valid binary frame for a detached session without closing', () => {
    const sock = new BrowserSocket()
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
    })
    hub.connect()
    sock.open()
    sock.recvBinary(
      encodeBinaryEnvelope(
        { v: 1, type: 'ptyOutput', sessionId: asSessionId('ghost'), seq: 0, epoch: 0 },
        Uint8Array.of(1),
      ),
    )
    expect(sock.closeCalls).toBe(0)
  })

  it('closes only the receiving connection for malformed or unnegotiated binary', () => {
    const malformed = new BrowserSocket()
    const malformedHub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => malformed,
    })
    malformedHub.connect()
    malformed.open()
    malformed.recvBinary(Uint8Array.of(0, 1))
    expect(malformed.closeCalls).toBe(1)
    expect(malformedHub.wireSkew()?.refusedFrames).toBe(1)

    const unnegotiated = new NonBinarySocket()
    const legacyHub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => unnegotiated,
    })
    legacyHub.connect()
    unnegotiated.open()
    unnegotiated.onmessage?.({ data: new ArrayBuffer(4) })
    expect(unnegotiated.closeCalls).toBe(1)
  })

  it('captures the server-assigned clientId from welcome', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    expect(hub.clientId).toBe('c0')
  })

  it('yields one feed frame per task and reports feed budgets', () => {
    const sock = new FakeSocket()
    const tasks: Array<() => void> = []
    const frames: unknown[] = []
    const timings: unknown[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
      feed: {
        helloFields: () => null,
        connected: () => {},
        disconnected: () => {},
        frame: (frame) => frames.push(frame),
      },
      scheduleFeedTask: (task) => tasks.push(task),
    })
    hub.on('feedTask', (timing) => timings.push(timing))
    hub.connect()
    sock.open()

    const rawBootstrap = (last: boolean) =>
      JSON.stringify({
        type: 'feedBootstrap',
        feedId: 'feed-1',
        epoch: 'e1',
        fromSeq: 0,
        seq: 0,
        minAvailableSeq: 0,
        changes: [],
        last,
      })
    sock.onmessage?.({ data: rawBootstrap(false) })
    sock.onmessage?.({ data: rawBootstrap(true) })

    expect(frames).toHaveLength(0)
    expect(tasks).toHaveLength(1)
    tasks.shift()?.()

    expect(frames).toHaveLength(1)
    expect(tasks).toHaveLength(1)
    tasks.shift()?.()
    expect(frames).toHaveLength(2)
    expect(timings).toEqual([
      expect.objectContaining({
        kind: 'feedBootstrap',
        yielded: true,
        overTaskBudget: false,
        overInteractabilityBudget: false,
      }),
      expect.objectContaining({ kind: 'feedBootstrap', yielded: true }),
    ])
    expect(hub.feedBudget()).toMatchObject({ tasks: 2, yieldedTasks: 2, maxQueueDepth: 2 })
    hub.dispose()
  })

  it('discards yielded feed frames when their socket closes', () => {
    const sock = new FakeSocket()
    const tasks: Array<() => void> = []
    const frames: unknown[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
      feed: {
        helloFields: () => null,
        connected: () => {},
        disconnected: () => {},
        frame: (frame) => frames.push(frame),
      },
      scheduleFeedTask: (task) => tasks.push(task),
    })
    hub.connect()
    sock.open()
    sock.recv({
      type: 'feedBootstrap',
      feedId: 'old-feed',
      epoch: 'old-epoch',
      fromSeq: 0,
      seq: 0,
      minAvailableSeq: 0,
      changes: [],
      last: true,
    })

    expect(tasks).toHaveLength(1)
    sock.close()
    tasks.shift()?.()

    expect(frames).toEqual([])
    expect(hub.feedBudget().tasks).toBe(0)
    hub.dispose()
  })

  it('trades a runaway delta backlog for a snapshot resync instead of replaying it', () => {
    // The terminal shape this bounds: deltas arrive faster than one-per-macrotask
    // replay can drain them, the queue only grows, and the main thread never
    // catches up. Past the bound the queue is dropped and the socket cycled —
    // the fresh admission's pushed world replaces the whole backlog with ONE
    // install (`requestFreshWorld`).
    const sock = new FakeSocket()
    const tasks: Array<() => void> = []
    const frames: unknown[] = []
    let disconnects = 0
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
      feed: {
        // No position to present: these cases are about the backlog bound, and a
        // cold hello is the honest answer for a hub that has installed nothing.
        helloFields: () => null,
        connected: () => {},
        disconnected: () => {
          disconnects += 1
        },
        frame: (frame) => frames.push(frame),
      },
      scheduleFeedTask: (task) => tasks.push(task),
    })
    hub.connect()
    sock.open()

    const rawDelta = (seq: number) =>
      JSON.stringify({
        type: 'feedDelta',
        feedId: 'f1',
        epoch: 'e1',
        fromSeq: seq - 1,
        seq,
        minAvailableSeq: 0,
        changes: [],
      })
    for (let seq = 1; seq <= FEED_DELTA_RESYNC_QUEUE_DEPTH + 1; seq += 1) {
      sock.onmessage?.({ data: rawDelta(seq) })
    }

    // The backlog was dropped, not replayed: whatever was scheduled before the
    // bound tripped delivers nothing.
    while (tasks.length > 0) tasks.shift()?.()
    expect(frames).toEqual([])
    expect(hub.feedBudget().backlogResyncs).toBe(1)
    // The socket was cycled, which is what makes the server push a fresh world.
    expect(disconnects).toBe(1)
    hub.dispose()
  })

  it('does not count a bootstrap world toward the resync bound — a large world is not a backlog', () => {
    // The counter-case that keeps the bound from looping: a big slice arrives as
    // an arbitrarily long run of feedBootstrap chunks, and abandoning THAT
    // download would request another world forever.
    const sock = new FakeSocket()
    const tasks: Array<() => void> = []
    const frames: unknown[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
      feed: {
        helloFields: () => null,
        connected: () => {},
        disconnected: () => {},
        frame: (frame) => frames.push(frame),
      },
      scheduleFeedTask: (task) => tasks.push(task),
    })
    hub.connect()
    sock.open()

    const rawChunk = (last: boolean) =>
      JSON.stringify({
        type: 'feedBootstrap',
        feedId: 'f1',
        epoch: 'e1',
        fromSeq: 0,
        seq: 0,
        minAvailableSeq: 0,
        changes: [],
        last,
      })
    for (let i = 0; i < FEED_DELTA_RESYNC_QUEUE_DEPTH + 1; i += 1) {
      sock.onmessage?.({ data: rawChunk(false) })
    }
    sock.onmessage?.({ data: rawChunk(true) })

    expect(hub.feedBudget().backlogResyncs).toBe(0)
    while (tasks.length > 0) tasks.shift()?.()
    expect(frames).toHaveLength(FEED_DELTA_RESYNC_QUEUE_DEPTH + 2)
    hub.dispose()
  })

  it('exposes sessionsChanged via sessions() + onSessions', () => {
    const { sock, hub } = setup()
    const seen: number[] = []
    hub.onSessions((s) => seen.push(s.length))
    hub.connect()
    sock.open()
    const meta = {
      sessionId: asSessionId('s1'),
      agentKind: 'claude-code' as const,
      title: 't',
      cwd: '/w',
      status: 'live' as const,
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 1,
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'spawn' as const },
      archived: false,
      readAt: null,
      unread: false,
    }
    sock.recv({ type: 'sessionsChanged', sessions: [meta] })
    expect(hub.sessions()).toEqual([meta])
    expect(seen.at(-1)).toBe(1)

    sock.recv({ type: 'sessionViewDelta', removedSessionIds: ['s1'] })
    expect(hub.sessions()).toEqual([])
    expect(seen.at(-1)).toBe(0)
  })

  it('quarantines a poisoned session in a batch and still exposes the rest (lenient route)', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const good = {
      sessionId: 's1',
      agentKind: 'claude-code',
      title: 't',
      cwd: '/w',
      status: 'live',
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 1,
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'spawn' },
      archived: false,
    }
    const bad = { ...good, sessionId: 'bad', agentKind: 'auto' } // out-of-enum poison
    // A real sink, not a console spy: the diagnostic travels as a record now.
    // No `minLevel`, so it follows the namespace level as production sinks do —
    // which is what keeps "the drop is observable" a claim about what a real
    // deployment shows, not about what a test happened to turn on.
    const captured: { level: string }[] = []
    const restore = addSink({ name: 'hub-test-capture', write: (r) => captured.push(r) })
    // Raw frame (bypasses the typed encode) carrying one poisoned element.
    sock.onmessage?.({ data: JSON.stringify({ type: 'sessionsChanged', sessions: [good, bad] }) })
    // The whole list is NOT dropped — the good session survives, the bad one is gone…
    expect(hub.sessions().map((s) => s.sessionId)).toEqual(['s1'])
    // …and the drop is observable, not silent.
    expect(captured.filter((r) => r.level === 'warn').length).toBeGreaterThan(0)
    restore()
  })

  it('dispatches headlessActivity frames to the matching session subscribers only', () => {
    const { sock, hub } = setup()
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    const unsubA = hub.subscribeHeadless(asSessionId('sA'), (e) => seenA.push(e))
    hub.subscribeHeadless(asSessionId('sB'), (e) => seenB.push(e))
    hub.connect()
    sock.open()
    sock.recv({
      type: 'headlessActivity',
      sessionId: asSessionId('sA'),
      event: { kind: 'turn-start' },
    })
    sock.recv({
      type: 'headlessActivity',
      sessionId: asSessionId('sA'),
      event: { kind: 'partial-text', text: 'hel' },
    })
    sock.recv({
      type: 'headlessActivity',
      sessionId: asSessionId('sB'),
      event: { kind: 'status', status: 'tool', label: 'Bash' },
    })
    expect(seenA).toEqual([{ kind: 'turn-start' }, { kind: 'partial-text', text: 'hel' }])
    expect(seenB).toEqual([{ kind: 'status', status: 'tool', label: 'Bash' }])
    // Unsubscribe stops delivery; other sessions unaffected.
    unsubA()
    sock.recv({
      type: 'headlessActivity',
      sessionId: asSessionId('sA'),
      event: { kind: 'turn-end' },
    })
    expect(seenA).toHaveLength(2)
  })

  it('drops headlessActivity for sessions with no subscriber without throwing', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    expect(() =>
      sock.recv({
        type: 'headlessActivity',
        sessionId: asSessionId('ghost'),
        event: { kind: 'turn-start' },
      }),
    ).not.toThrow()
  })

  it('exposes conversationsChanged via conversations() + onConversations', () => {
    const { sock, hub } = setup()
    const seen: number[] = []
    hub.onConversations((conversations) => seen.push(conversations.length))
    hub.connect()
    sock.open()
    const conversation = {
      id: 'conv-1',
      agentKind: 'codex' as const,
      title: 'Cached discovery',
      projectPath: '/w',
      providerId: 'codex-jsonl',
      resume: { kind: 'codex-thread' as const, value: 'conv-1' },
    }
    sock.recv({ type: 'conversationsChanged', conversations: [conversation], diagnostics: [] })
    expect(hub.conversations()).toEqual([conversation])
    expect(seen.at(-1)).toBe(1)
  })

  it('patches a single session title on sessionTitleChanged and notifies observers', () => {
    const { sock, hub } = setup()
    const meta = {
      sessionId: asSessionId('s1'),
      agentKind: 'claude-code' as const,
      title: 'proj',
      cwd: '/w',
      status: 'live' as const,
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 1,
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
      origin: { kind: 'spawn' as const },
      archived: false,
      readAt: null,
      unread: false,
    }
    const titles: string[] = []
    hub.onSessions((s) => {
      if (s[0]) titles.push(s[0].title)
    })
    hub.connect()
    sock.open()
    sock.recv({ type: 'sessionsChanged', sessions: [meta] })
    sock.recv({ type: 'sessionTitleChanged', sessionId: asSessionId('s1'), title: '⠹ podium' })
    expect(hub.sessions().at(0)?.title).toBe('⠹ podium')
    expect(titles.at(-1)).toBe('⠹ podium')
    // An unchanged title doesn't churn observers.
    const count = titles.length
    sock.recv({ type: 'sessionTitleChanged', sessionId: asSessionId('s1'), title: '⠹ podium' })
    expect(titles.length).toBe(count)
    // A title for an unknown session is ignored.
    sock.recv({ type: 'sessionTitleChanged', sessionId: asSessionId('ghost'), title: 'x' })
    expect(titles.length).toBe(count)
  })

  it('attach sends an attach message and returns a SessionConnection', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const conn = hub.attach(asSessionId('s1'))
    expect(conn.sessionId).toBe('s1')
    expect(sock.parsed()).toContainEqual({ type: 'attach', sessionId: 's1' })
  })

  it('queues a control send issued before open (slow connect) and flushes on open, no throw', () => {
    // A real browser WebSocket throws InvalidStateError when send() is called in the
    // CONNECTING state. This only surfaces over a high-latency link (a tunnel), where
    // an eager requestControl on mount fires before onopen. Regression for that crash.
    class ConnectingSocket extends FakeSocket {
      private opened = false
      override send(data: string): void {
        if (!this.opened) {
          throw Object.assign(new Error('Still in CONNECTING state'), { name: 'InvalidStateError' })
        }
        super.send(data)
      }
      override open(): void {
        this.opened = true
        super.open()
      }
    }
    const sock = new ConnectingSocket()
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
    })
    hub.connect()
    const conn = hub.attach(asSessionId('s1'))
    // Fired before the socket opens — must NOT throw (previously crashed the connection).
    expect(() => conn.requestControl()).not.toThrow()
    expect(sock.sent).toHaveLength(0) // nothing sent while still connecting
    sock.open()
    // Flushed after open (and after the re-attach), in order.
    expect(sock.parsed()).toContainEqual({ type: 'requestControl', sessionId: 's1' })
  })

  it('re-sends attach for existing connections on reconnect (open)', () => {
    const { sock, hub } = setup()
    hub.attach(asSessionId('s1')) // attached before connect
    hub.connect()
    sock.open()
    expect(sock.parsed().filter((m) => m.type === 'attach')).toContainEqual({
      type: 'attach',
      sessionId: 's1',
    })
  })

  it('routes frames to the matching session only (isolation)', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    const f1: Uint8Array[] = []
    const f2: Uint8Array[] = []
    hub.attach(asSessionId('s1'), { onFrame: (t) => f1.push(t) })
    hub.attach(asSessionId('s2'), { onFrame: (t) => f2.push(t) })
    sock.recv({
      type: 'outputFrame',
      sessionId: asSessionId('s1'),
      seq: 0,
      epoch: 0,
      data: b64('one'),
    })
    sock.recv({
      type: 'outputFrame',
      sessionId: asSessionId('s2'),
      seq: 0,
      epoch: 0,
      data: b64('two'),
    })
    expect(f1).toEqual([utf8('one')])
    expect(f2).toEqual([utf8('two')])
  })

  it('drops session-scoped messages for unknown sessions without throwing', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    expect(() =>
      sock.recv({
        type: 'outputFrame',
        sessionId: asSessionId('ghost'),
        seq: 0,
        epoch: 0,
        data: b64('x'),
      }),
    ).not.toThrow()
  })

  it('notifies connection errors so the app can render a fallback', () => {
    const sock = new FakeSocket()
    const errors: string[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
      onError: (message) => errors.push(message),
    })
    hub.connect()
    sock.error()
    expect(errors).toEqual(['WebSocket connection failed'])
  })

  it('does not report an intentional dispose before the socket opens as a connection error', () => {
    const sock = new FakeSocket()
    const errors: string[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => sock,
      onError: (message) => errors.push(message),
    })
    hub.connect()
    hub.dispose()
    expect(errors).toEqual([])
  })
})

describe('SessionConnection (hub-backed)', () => {
  it('computes role from the hub clientId vs the session controllerId', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    const conn = hub.attach(asSessionId('s1'))
    sock.recv({
      type: 'attached',
      sessionId: asSessionId('s1'),
      controllerId: 'c0',
      geometry: { cols: 90, rows: 30 },
      epoch: 0,
    })
    expect(conn.state()).toMatchObject({
      role: 'controller',
      cols: 90,
      rows: 30,
      controllerId: 'c0',
    })
    sock.recv({
      type: 'controllerChanged',
      sessionId: asSessionId('s1'),
      controllerId: 'c9',
      geometry: { cols: 90, rows: 30 },
    })
    expect(conn.state().role).toBe('spectator')
  })

  it('tags input/resize/requestControl/redraw with the sessionId', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const conn = hub.attach(asSessionId('s1'))
    conn.sendInput('x')
    conn.sendResize(120, 40)
    conn.reportViewport(63, 28)
    conn.requestControl()
    conn.redraw()
    const sent = sock.parsed()
    expect(sent).toContainEqual({ type: 'input', sessionId: 's1', data: b64('x') })
    expect(sent).toContainEqual({ type: 'resize', sessionId: 's1', cols: 120, rows: 40 })
    expect(sent).toContainEqual({ type: 'resize', sessionId: 's1', cols: 63, rows: 28 })
    expect(conn.state()).toMatchObject({
      cols: 80,
      rows: 24,
      requestedGeometry: { cols: 120, rows: 40 },
    })
    expect(sent).toContainEqual({ type: 'requestControl', sessionId: 's1' })
    expect(sent).toContainEqual({ type: 'redrawRequest', sessionId: 's1' })
  })

  it('carries claim geometry atomically and keeps UI pending until server acknowledgment', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    const conn = hub.attach(asSessionId('s1'))
    sock.recv({
      type: 'attached',
      sessionId: asSessionId('s1'),
      controllerId: 'c9',
      geometry: { cols: 103, rows: 28 },
      epoch: 0,
    })

    conn.requestControl({ cols: 62, rows: 36 })
    expect(sock.parsed()).toContainEqual({
      type: 'requestControl',
      sessionId: 's1',
      geometry: { cols: 62, rows: 36 },
    })
    expect(conn.state()).toMatchObject({
      role: 'spectator',
      cols: 103,
      rows: 28,
      requestedGeometry: { cols: 62, rows: 36 },
    })

    sock.recv({
      type: 'controllerChanged',
      sessionId: asSessionId('s1'),
      controllerId: 'c0',
      geometry: { cols: 62, rows: 36 },
    })
    expect(conn.state()).toMatchObject({
      role: 'controller',
      cols: 62,
      rows: 36,
      requestedGeometry: null,
    })
  })

  it('fires onAttached once when the server confirms the attach (no output required)', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    const onAttached = vi.fn()
    hub.attach(asSessionId('s1'), { onAttached })
    expect(onAttached).not.toHaveBeenCalled()
    sock.recv({
      type: 'attached',
      sessionId: asSessionId('s1'),
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
    })
    expect(onAttached).toHaveBeenCalledTimes(1)
  })

  // POD-385: a blank screen alone cannot say whether the child has printed
  // nothing yet or whether we simply don't hold its replay, so the attach
  // carries the server's durable answer and the first frame latches it.
  describe('outputSeen', () => {
    const attach = (sock: FakeSocket, outputSeen?: boolean): void => {
      sock.recv({
        type: 'attached',
        sessionId: asSessionId('s1'),
        controllerId: 'c0',
        geometry: { cols: 80, rows: 24 },
        epoch: 0,
        ...(outputSeen === undefined ? {} : { outputSeen }),
      })
    }

    it('is true before any attach, so nothing claims silence on no evidence', () => {
      const { sock, hub } = setup()
      hub.connect()
      sock.open()
      expect(hub.attach(asSessionId('s1')).state().outputSeen).toBe(true)
    })

    it('is false while the attach reports a PTY that has never produced output', () => {
      const { sock, hub } = setup()
      hub.connect()
      sock.open()
      const conn = hub.attach(asSessionId('s1'))
      attach(sock, false)
      expect(conn.state().outputSeen).toBe(false)
    })

    it('latches true on the first non-empty frame', () => {
      const { sock, hub } = setup()
      hub.connect()
      sock.open()
      const states: boolean[] = []
      const conn = hub.attach(asSessionId('s1'), { onState: (s) => states.push(s.outputSeen) })
      attach(sock, false)
      sock.recv({
        type: 'outputFrame',
        sessionId: asSessionId('s1'),
        seq: 0,
        epoch: 0,
        data: b64(''),
      })
      expect(conn.state().outputSeen).toBe(false) // an empty frame said nothing
      sock.recv({
        type: 'outputFrame',
        sessionId: asSessionId('s1'),
        seq: 1,
        epoch: 0,
        data: b64('$ '),
      })
      expect(conn.state().outputSeen).toBe(true)
      // The state published WITH the first real frame already says so — a panel
      // clearing its waiting affordance on the state must not see one more
      // "silent" snapshot after the PTY has spoken.
      expect(states.at(-1)).toBe(true)
    })

    it('assumes output against a server too old to report it', () => {
      const { sock, hub } = setup()
      hub.connect()
      sock.open()
      const conn = hub.attach(asSessionId('s1'))
      attach(sock, undefined)
      expect(conn.state().outputSeen).toBe(true)
    })

    it('never un-sees output a later attach forgot', () => {
      const { sock, hub } = setup()
      hub.connect()
      sock.open()
      const conn = hub.attach(asSessionId('s1'))
      attach(sock, true)
      sock.recv({
        type: 'outputFrame',
        sessionId: asSessionId('s1'),
        seq: 0,
        epoch: 0,
        data: b64('hi'),
      })
      attach(sock, false)
      expect(conn.state().outputSeen).toBe(true)
    })
  })

  it('updates lastSeq/epoch and emits the decoded bytes', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const frames: Uint8Array[] = []
    let stateAtCallback: { lastSeq: number; epoch: number } | undefined
    const conn = hub.attach(asSessionId('s1'), {
      onFrame: (bytes) => {
        frames.push(bytes)
        stateAtCallback = conn.state()
      },
    })
    sock.recv({
      type: 'outputFrame',
      sessionId: asSessionId('s1'),
      seq: 5,
      epoch: 2,
      data: b64('hello'),
    })
    expect(frames).toEqual([utf8('hello')])
    expect(stateAtCallback).toMatchObject({ lastSeq: 5, epoch: 2 })
    expect(conn.state()).toMatchObject({ lastSeq: 5, epoch: 2 })
  })

  it('preserves UTF-8 bytes split across output frames', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const frames: Uint8Array[] = []
    hub.attach(asSessionId('s1'), { onFrame: (bytes) => frames.push(bytes) })

    sock.recv({
      type: 'outputFrame',
      sessionId: asSessionId('s1'),
      seq: 1,
      epoch: 0,
      data: b64Bytes(0xe2, 0x82),
    })
    sock.recv({
      type: 'outputFrame',
      sessionId: asSessionId('s1'),
      seq: 2,
      epoch: 0,
      data: b64Bytes(0xac),
    })

    expect(frames).toEqual([Uint8Array.of(0xe2, 0x82), Uint8Array.of(0xac)])
  })

  it('applies geometry updates', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const conn = hub.attach(asSessionId('s1'))
    sock.recv({ type: 'geometry', sessionId: asSessionId('s1'), cols: 111, rows: 41 })
    expect(conn.state()).toMatchObject({ cols: 111, rows: 41 })
  })

  it('handles agentExit without throwing and still emits state', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const states: string[] = []
    hub.attach(asSessionId('s1'), { onState: (s) => states.push(s.role) })
    expect(() =>
      sock.recv({ type: 'agentExit', sessionId: asSessionId('s1'), code: 0 }),
    ).not.toThrow()
    expect(states.length).toBeGreaterThan(0)
  })

  it('re-attach updates callbacks without sending a second attach', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    hub.attach(asSessionId('s1'))
    const before = sock.parsed().filter((m) => m.type === 'attach' && m.sessionId === 's1').length
    const frames: Uint8Array[] = []
    hub.attach(asSessionId('s1'), { onFrame: (t) => frames.push(t) })
    const after = sock.parsed().filter((m) => m.type === 'attach' && m.sessionId === 's1').length
    expect(after).toBe(before) // no duplicate attach
    sock.recv({
      type: 'outputFrame',
      sessionId: asSessionId('s1'),
      seq: 0,
      epoch: 0,
      data: btoa('hi'),
    })
    expect(frames).toEqual([utf8('hi')])
  })
})

describe('SocketHub reconnect + heartbeat', () => {
  function multiSetup() {
    const sockets: FakeSocket[] = []
    const errors: string[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      onError: (m) => errors.push(m),
    })
    return { sockets, hub, errors }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('wake tears down a live socket and dials immediately, without waiting for backoff', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.attach(asSessionId('s1'))
    expect(sockets).toHaveLength(1)
    hub.wake()
    expect(hub.connected).toBe(false)
    expect(sockets).toHaveLength(2)
    sockets[1]?.open()
    expect(hub.connected).toBe(true)
    expect(sockets[1]?.parsed()).toContainEqual({ type: 'attach', sessionId: 's1' })
    // Backoff is 500ms; stay under the 10s heartbeat so this does not also
    // measure a later force-close.
    vi.advanceTimersByTime(2_000)
    expect(sockets).toHaveLength(2)
  })

  it('wake connects when nothing is open yet', () => {
    const { sockets, hub } = multiSetup()
    hub.wake()
    expect(sockets).toHaveLength(1)
  })

  it('reconnects after an unintentional close and re-attaches sessions', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.attach(asSessionId('s1'))
    sockets[0]?.close() // backend died / proxy dropped the socket
    expect(hub.connected).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(sockets.length).toBe(2)
    sockets[1]?.open()
    expect(hub.connected).toBe(true)
    expect(sockets[1]?.parsed()).toContainEqual({ type: 'attach', sessionId: 's1' })
  })

  it('retries when the initial connection closes before opening', () => {
    vi.useFakeTimers()
    const { sockets, hub, errors } = multiSetup()
    hub.connect()
    sockets[0]?.close()
    expect(errors).toEqual(['WebSocket connection closed before connecting'])
    vi.advanceTimersByTime(30_000)
    expect(sockets).toHaveLength(2)
  })

  it('keeps retrying with backoff until the server is back', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    sockets[0]?.close()
    // Each failed attempt (close without open) schedules another try.
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(60_000)
      sockets.at(-1)?.close()
    }
    vi.advanceTimersByTime(60_000)
    expect(sockets.length).toBeGreaterThanOrEqual(5)
    sockets.at(-1)?.open()
    expect(hub.connected).toBe(true)
  })

  it('does not reconnect after an intentional dispose', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.dispose()
    vi.advanceTimersByTime(120_000)
    expect(sockets.length).toBe(1)
  })

  it('detects a silent half-open connection via heartbeat and reconnects', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    // The first ping goes out immediately on open (it doubles as the latency probe).
    expect(sockets[0]?.parsed()).toContainEqual({ type: 'ping' })
    // No pong arrives: the connection is declared dead and a reconnect scheduled.
    vi.advanceTimersByTime(10_000)
    expect(hub.connected).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(sockets.length).toBe(2)
  })

  it('pong replies keep a live connection open', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    sockets[0]?.recv({ type: 'pong' }) // answer the on-open ping
    // Advance exactly one heartbeat interval at a time and answer each ping
    // immediately, the way a live server would.
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(2_500)
      sockets[0]?.recv({ type: 'pong' })
    }
    expect(hub.connected).toBe(true)
    expect(sockets.length).toBe(1)
  })

  it('does not report a fatal error for drops after a successful open', () => {
    vi.useFakeTimers()
    const { sockets, hub, errors } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    sockets[0]?.close()
    vi.advanceTimersByTime(60_000)
    sockets.at(-1)?.close() // the retry failing silently is also not fatal
    expect(errors).toEqual([])
  })
})

describe('connection health', () => {
  function multiSetup() {
    const sockets: FakeSocket[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    return { sockets, hub }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts ok with no measurement', () => {
    const { hub } = multiSetup()
    expect(hub.connectionHealth()).toMatchObject({ status: 'ok', rttMs: null })
  })

  it('measures rtt from the ping/pong round-trip and stays ok when fast', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open() // ping sent immediately
    vi.advanceTimersByTime(80)
    sockets[0]?.recv({ type: 'pong' })
    expect(hub.connectionHealth()).toMatchObject({ status: 'ok', rttMs: 80 })
  })

  it('degrades on a slow pong and recovers on a fast one', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    vi.advanceTimersByTime(600)
    sockets[0]?.recv({ type: 'pong' })
    expect(hub.connectionHealth()).toMatchObject({ status: 'degraded', rttMs: 600 })
    vi.advanceTimersByTime(1_900) // land exactly on the next heartbeat ping (t=2.5s)
    sockets[0]?.recv({ type: 'pong' }) // answered instantly
    expect(hub.connectionHealth()).toMatchObject({ status: 'ok', rttMs: 0 })
  })

  it('degrades while a ping goes unanswered, then reports down', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open() // ping at t=0, never answered
    vi.advanceTimersByTime(1_500)
    expect(hub.connectionHealth().status).toBe('degraded')
    vi.advanceTimersByTime(3_500) // t=5s since the ping
    expect(hub.connectionHealth().status).toBe('down')
  })

  it('reports down while disconnected and recovers after a reconnect pong', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    sockets[0]?.recv({ type: 'pong' })
    expect(hub.connectionHealth().status).toBe('ok')
    sockets[0]?.close()
    expect(hub.connectionHealth().status).toBe('down')
    vi.advanceTimersByTime(30_000)
    const next = sockets.at(-1)
    expect(next).not.toBe(sockets[0])
    next?.open()
    next?.recv({ type: 'pong' })
    expect(hub.connectionHealth()).toMatchObject({ status: 'ok', rttMs: 0 })
  })

  it('notifies observers with a replay and only on change', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    const seen: Array<{ status: string; rttMs: number | null }> = []
    hub.onConnectionHealth((h) => seen.push(h))
    hub.connect()
    sockets[0]?.open()
    sockets[0]?.recv({ type: 'pong' }) // rtt 0
    vi.advanceTimersByTime(2_500)
    sockets[0]?.recv({ type: 'pong' }) // rtt 0 again — no change, no emit
    expect(seen.map(({ status, rttMs }) => ({ status, rttMs }))).toEqual([
      { status: 'ok', rttMs: null },
      { status: 'ok', rttMs: 0 },
    ])
  })

  it('keeps `since` pinned to the status transition, not later re-evaluations', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open() // ping at t=0, never answered
    vi.advanceTimersByTime(1_500)
    const degradedAt = hub.connectionHealth().since
    expect(hub.connectionHealth().status).toBe('degraded')
    vi.advanceTimersByTime(1_000) // still degraded — same transition keeps its timestamp
    expect(hub.connectionHealth().since).toBe(degradedAt)
    vi.advanceTimersByTime(2_500) // crosses the down threshold → new transition
    expect(hub.connectionHealth().status).toBe('down')
    expect(hub.connectionHealth().since).toBeGreaterThan(degradedAt)
  })
})

describe('resume + offline input queue', () => {
  function multiSetup() {
    const sockets: FakeSocket[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    return { sockets, hub }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-attaches with a resume cursor (lastSeq) after rendering frames', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.attach(asSessionId('s1'))
    sockets[0]?.recv({
      type: 'outputFrame',
      sessionId: asSessionId('s1'),
      seq: 4,
      epoch: 0,
      data: b64('x'),
    })
    sockets[0]?.close()
    vi.advanceTimersByTime(30_000)
    sockets[1]?.open()
    // The view survived the drop, so the reconnect asks to resume from seq 4.
    expect(sockets[1]?.parsed()).toContainEqual({ type: 'attach', sessionId: 's1', sinceSeq: 4 })
  })

  it('omits the cursor when nothing has been rendered yet (full replay)', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.attach(asSessionId('s1')) // no frames received
    sockets[0]?.close()
    vi.advanceTimersByTime(30_000)
    sockets[1]?.open()
    expect(sockets[1]?.parsed()).toContainEqual({ type: 'attach', sessionId: 's1' })
    expect(sockets[1]?.parsed().some((m) => m.type === 'attach' && 'sinceSeq' in m)).toBe(false)
  })

  it('queues input typed while disconnected and flushes it in order on reconnect', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    const conn = hub.attach(asSessionId('s1'))
    sockets[0]?.close() // the socket drops
    conn.sendInput('a')
    conn.sendInput('b')
    // Nothing was written to the dead socket.
    expect(sockets[0]?.parsed().some((m) => m.type === 'input')).toBe(false)
    vi.advanceTimersByTime(30_000)
    sockets[1]?.open()
    const inputs = sockets[1]?.parsed().filter((m) => m.type === 'input')
    expect(inputs).toEqual([
      { type: 'input', sessionId: 's1', data: b64('a') },
      { type: 'input', sessionId: 's1', data: b64('b') },
    ])
  })

  it('downgrades input on reconnect until the new welcome acknowledges it', () => {
    vi.useFakeTimers()
    const sockets: BinaryInputSocket[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => {
        const socket = new BinaryInputSocket()
        sockets.push(socket)
        return socket
      },
    })
    hub.connect()
    sockets[0]?.open()
    const conn = hub.attach(asSessionId('s1'))
    sockets[0]?.recv({ type: 'welcome', clientId: 'c0', caps: [CAP_TERMINAL_INPUT_BINARY_V1] })
    conn.sendInput('first')
    expect(sockets[0]?.binarySent).toHaveLength(1)

    sockets[0]?.close()
    conn.sendInput('paste')
    conn.sendInput('\r')
    vi.advanceTimersByTime(30_000)
    sockets[1]?.open()
    expect(sockets[1]?.binarySent).toHaveLength(0)
    expect(sockets[1]?.parsed().filter((message) => message.type === 'input')).toEqual([
      { type: 'input', sessionId: 's1', data: b64('paste') },
      { type: 'input', sessionId: 's1', data: b64('\r') },
    ])

    sockets[1]?.recv({ type: 'welcome', clientId: 'c1', caps: [] })
    conn.sendInput('after-downgrade')
    expect(sockets[1]?.binarySent).toHaveLength(0)
    expect(sockets[1]?.parsed()).toContainEqual({
      type: 'input',
      sessionId: 's1',
      data: b64('after-downgrade'),
    })
  })

  it('does not replay queued input after an intentional dispose', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    const conn = hub.attach(asSessionId('s1'))
    sockets[0]?.close()
    conn.sendInput('x')
    hub.dispose() // user closed the tab / tore down the hub
    hub.connect() // a brand-new session later
    sockets.at(-1)?.open()
    expect(
      sockets
        .at(-1)
        ?.parsed()
        .some((m) => m.type === 'input'),
    ).toBe(false)
  })

  it('calls onReset on a full attach but not on a resumed one', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    let resets = 0
    hub.attach(asSessionId('s1'), { onReset: () => (resets += 1) })
    sock.recv({
      type: 'attached',
      sessionId: asSessionId('s1'),
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      resumed: false,
    })
    expect(resets).toBe(1)
    sock.recv({
      type: 'attached',
      sessionId: asSessionId('s1'),
      controllerId: 'c0',
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      resumed: true,
    })
    expect(resets).toBe(1) // a resume keeps the screen — no clear
  })
})

describe('transcript delta forwarding', () => {
  const item = (id: string, cursor: string): import('@podium/model').TranscriptItem => ({
    id,
    cursor,
    role: 'assistant' as const,
    text: id,
  })

  it('first subscribe sends transcriptSubscribe (with since) and does NOT call cb synchronously', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    const calls: Array<{ items: number; reset: boolean }> = []
    hub.subscribeTranscript(asSessionId('s1'), 'c0', (items, meta) => {
      calls.push({ items: items.length, reset: meta.reset })
    })
    expect(calls).toEqual([]) // no synchronous cb — the read seeds initial state
    expect(sock.parsed()).toContainEqual({
      type: 'transcriptSubscribe',
      sessionId: 's1',
      since: 'c0',
    })
  })

  it('omits since when undefined', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    hub.subscribeTranscript(asSessionId('s1'), undefined, () => {})
    expect(sock.parsed()).toContainEqual({ type: 'transcriptSubscribe', sessionId: 's1' })
  })

  it('forwards a transcriptDelta frame as delta items with reset=false', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    const calls: Array<{ ids: string[]; reset: boolean }> = []
    hub.subscribeTranscript(asSessionId('s1'), undefined, (items, meta) => {
      calls.push({ ids: items.map((i) => i.id), reset: meta.reset })
    })
    sock.recv({
      type: 'transcriptDelta',
      sessionId: asSessionId('s1'),
      items: [item('a', 'c1')],
      tail: 'c1',
    })
    sock.recv({
      type: 'transcriptDelta',
      sessionId: asSessionId('s1'),
      items: [item('b', 'c2')],
      tail: 'c2',
    })
    // Each frame forwards ONLY its own delta items (no accumulation in the hub).
    expect(calls).toEqual([
      { ids: ['a'], reset: false },
      { ids: ['b'], reset: false },
    ])
  })

  it('forwards reset=true from a reset delta', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    const resets: boolean[] = []
    hub.subscribeTranscript(asSessionId('s1'), undefined, (_items, meta) => resets.push(meta.reset))
    sock.recv({
      type: 'transcriptDelta',
      sessionId: asSessionId('s1'),
      items: [item('a', 'c1')],
      reset: true,
    })
    expect(resets).toEqual([true])
  })

  it('tracks since from the delta tail and re-subscribes with it on reconnect', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    hub.connect()
    sockets[0]?.open()
    hub.subscribeTranscript(asSessionId('s1'), 'c0', () => {})
    sockets[0]?.recv({
      type: 'transcriptDelta',
      sessionId: asSessionId('s1'),
      items: [item('a', 'c5')],
      tail: 'c5',
    })
    sockets[0]?.close() // backend dropped the socket
    vi.advanceTimersByTime(30_000)
    sockets[1]?.open()
    // The re-subscribe carries the LATEST tracked since, not the original 'c0'.
    expect(sockets[1]?.parsed()).toContainEqual({
      type: 'transcriptSubscribe',
      sessionId: 's1',
      since: 'c5',
    })
    vi.useRealTimers()
  })

  // POD-1132: the agent panel subscribes at mount for its file-link index; the
  // chat subscribes only once its transcript read resolves, hundreds of ms
  // later. Everything appended in between went to the observers registered at
  // the time — the joiner's `since` is the only thing that can recover it, and
  // dropping it left a permanent hole the forward-only stream never refills.
  it('re-asserts the subscription from a LATER observer since, so its read gap is replayed', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    hub.subscribeTranscript(asSessionId('s1'), undefined, () => {})
    hub.subscribeTranscript(asSessionId('s1'), 'c7', () => {})
    expect(sock.parsed().filter((m) => m.type === 'transcriptSubscribe')).toEqual([
      { type: 'transcriptSubscribe', sessionId: 's1' },
      { type: 'transcriptSubscribe', sessionId: 's1', since: 'c7' },
    ])
  })

  it('a later observer with no cursor of its own asks for nothing', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    hub.subscribeTranscript(asSessionId('s1'), 'c0', () => {})
    hub.subscribeTranscript(asSessionId('s1'), undefined, () => {})
    expect(sock.parsed().filter((m) => m.type === 'transcriptSubscribe')).toHaveLength(1)
  })

  it('a joiner does not drag the reconnect resume backwards', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    hub.connect()
    sockets[0]?.open()
    hub.subscribeTranscript(asSessionId('s1'), undefined, () => {})
    sockets[0]?.recv({
      type: 'transcriptDelta',
      sessionId: asSessionId('s1'),
      items: [item('a', 'c9')],
      tail: 'c9',
    })
    // Joins with an OLDER cursor: it wants its own gap replayed, but the
    // connection as a whole has seen further and must resume from there.
    hub.subscribeTranscript(asSessionId('s1'), 'c3', () => {})
    sockets[0]?.close()
    vi.advanceTimersByTime(30_000)
    sockets[1]?.open()
    expect(sockets[1]?.parsed()).toContainEqual({
      type: 'transcriptSubscribe',
      sessionId: 's1',
      since: 'c9',
    })
    vi.useRealTimers()
  })

  it('ignores deltas for an unsubscribed session and unsubscribes on last observer leaving', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    const unsub = hub.subscribeTranscript(asSessionId('s1'), undefined, () => {})
    unsub()
    expect(sock.parsed()).toContainEqual({ type: 'transcriptUnsubscribe', sessionId: 's1' })
    // A late delta for the dropped session is a no-op (no throw).
    expect(() =>
      sock.recv({
        type: 'transcriptDelta',
        sessionId: asSessionId('s1'),
        items: [item('a', 'c1')],
      }),
    ).not.toThrow()
  })
})

describe('host metrics', () => {
  it('exposes hostMetricsChanged via hostMetrics() + onHostMetrics', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    const seen: number[] = []
    hub.onHostMetrics((h) => seen.push(h.length))
    const host = {
      hostname: 'podium-host',
      sampledAt: '2026-06-11T00:00:00.000Z',
      memory: { totalBytes: 32, availableBytes: 16, swapTotalBytes: 0, swapFreeBytes: 0 },
    }
    sock.recv({ type: 'hostMetricsChanged', hosts: [host] })
    expect(hub.hostMetrics()).toEqual([host])
    expect(seen).toEqual([0, 1]) // immediate replay + the update
    sock.recv({ type: 'hostMetricsChanged', hosts: [] })
    expect(hub.hostMetrics()).toEqual([])
    expect(seen).toEqual([0, 1, 0])
  })
})

describe('machines', () => {
  it('exposes machinesChanged via machines() + onMachines', () => {
    const { hub, sock } = setup()
    hub.connect()
    sock.open()
    const seen: number[] = []
    hub.onMachines((m) => seen.push(m.length))
    const machine = {
      id: asMachineId('m1'),
      name: 'box',
      hostname: 'box.local',
      online: true,
      lastSeenAt: '2026-06-17T00:00:00.000Z',
    }
    sock.recv({ type: 'machinesChanged', machines: [machine] })
    expect(hub.machines()).toEqual([machine])
    expect(seen).toEqual([0, 1]) // immediate replay + the update
    sock.recv({ type: 'machinesChanged', machines: [] })
    expect(hub.machines()).toEqual([])
    expect(seen).toEqual([0, 1, 0])
  })
})

describe('view state', () => {
  function multiSetup() {
    const sockets: FakeSocket[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    return { sockets, hub }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends viewState when connected', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    hub.setViewState([asSessionId('s1')], asSessionId('s1'))
    expect(sock.parsed()).toContainEqual({ type: 'viewState', visible: ['s1'], focused: 's1' })
  })

  it('does not send while disconnected but stores it for (re)connect', () => {
    const { sock, hub } = setup()
    hub.setViewState([asSessionId('s1')], asSessionId('s1')) // before connect
    expect(sock.parsed()).not.toContainEqual(expect.objectContaining({ type: 'viewState' }))
    hub.connect()
    sock.open()
    expect(sock.parsed()).toContainEqual({ type: 'viewState', visible: ['s1'], focused: 's1' })
  })

  it('includes the rendered-mode map when modes is provided', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    hub.setViewState([asSessionId('s1'), asSessionId('s2')], asSessionId('s1'), {
      s1: 'native',
      s2: 'chat',
    })
    expect(sock.parsed()).toContainEqual({
      type: 'viewState',
      visible: ['s1', 's2'],
      focused: 's1',
      modes: { s1: 'native', s2: 'chat' },
    })
  })

  it('merges a live renderer lease over layout reports and releases it independently', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    hub.setViewState([asSessionId('s1')], asSessionId('s1'), { s1: 'chat' })

    const release = hub.registerRenderedSession(asSessionId('s1'), {
      mode: 'native',
      focused: true,
    })
    expect(sock.parsed().at(-1)).toEqual({
      type: 'viewState',
      visible: ['s1'],
      focused: 's1',
      modes: { s1: 'native' },
    })

    // A later desktop-layout reaction cannot erase the mobile route's lease.
    hub.setViewState([], null)
    expect(sock.parsed().at(-1)).toEqual({
      type: 'viewState',
      visible: ['s1'],
      focused: 's1',
      modes: { s1: 'native' },
    })

    release()
    expect(sock.parsed().at(-1)).toEqual({ type: 'viewState', visible: [], focused: null })
  })

  it('re-asserts the last view state (with modes) on reconnect', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.setViewState([asSessionId('s1')], asSessionId('s1'), { s1: 'chat' })
    sockets[0]?.close()
    vi.advanceTimersByTime(30_000)
    expect(sockets.length).toBe(2)
    sockets[1]?.open()
    expect(sockets[1]?.parsed()).toContainEqual({
      type: 'viewState',
      visible: ['s1'],
      focused: 's1',
      modes: { s1: 'chat' },
    })
  })

  it('re-asserts the last view state on reconnect', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.setViewState([asSessionId('s1'), asSessionId('s2')], asSessionId('s2'))
    sockets[0]?.close() // backend died / proxy dropped the socket
    vi.advanceTimersByTime(30_000)
    expect(sockets.length).toBe(2)
    sockets[1]?.open()
    expect(sockets[1]?.parsed()).toContainEqual({
      type: 'viewState',
      visible: ['s1', 's2'],
      focused: 's2',
    })
  })
})

/** POD-2060: a fleet that lost the same server in the same second must not come
 *  back in lockstep, backoff must reset on evidence of a WORKING server rather
 *  than on TCP open, and out-of-band evidence that the network is back must skip
 *  the remaining wait. */
describe('SocketHub reconnect jitter and connectNow', () => {
  function multiSetup() {
    const sockets: FakeSocket[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      makeSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    })
    return { sockets, hub }
  }

  /** The delay the hub armed its reconnect timer with, taken from the only
   *  timeout scheduled while the socket closes (the heartbeat is stopped first). */
  function scheduledDelay(
    spy: { mockClear: () => void; mock: { calls: unknown[][] } },
    close: () => void,
  ): number {
    spy.mockClear()
    close()
    const delays = spy.mock.calls.map((c: unknown[]) => Number(c[1]))
    expect(delays).toHaveLength(1)
    return delays[0] as number
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('jitters every reconnect delay into [base/2, base) while the base still doubles', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open() // the one connection that gets to open; it sends nothing

    let base = 500
    for (let i = 0; i < 8; i += 1) {
      const delay = scheduledDelay(spy, () => sockets.at(-1)?.close())
      expect(delay).toBeGreaterThanOrEqual(base / 2)
      expect(delay).toBeLessThan(base)
      const before = sockets.length
      vi.advanceTimersByTime(delay)
      expect(sockets.length).toBe(before + 1)
      base = Math.min(base * 2, 10_000)
    }
  })

  it('fires at the jittered time, not at the undivided base delay', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    sockets[0]?.close()
    vi.advanceTimersByTime(249)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1) // base 500, random 0 → 250ms
    expect(sockets).toHaveLength(2)
  })

  it('keeps growing the backoff for a server that accepts then drops without traffic', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()

    // An accept-then-drop server (auth bounce, half-deployed proxy): every cycle
    // opens, says nothing, and closes. Resetting on TCP open would peg this at 500ms.
    let base = 500
    for (let i = 0; i < 4; i += 1) {
      const delay = scheduledDelay(spy, () => sockets.at(-1)?.close())
      expect(delay).toBeGreaterThanOrEqual(base / 2)
      expect(delay).toBeLessThan(base)
      vi.advanceTimersByTime(delay)
      sockets.at(-1)?.open()
      base = Math.min(base * 2, 10_000)
    }
    expect(base).toBe(8_000)
  })

  it('resets the backoff on the first inbound message of a connection', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    const first = scheduledDelay(spy, () => sockets[0]?.close())
    vi.advanceTimersByTime(first)

    sockets[1]?.open()
    sockets[1]?.recv({ type: 'welcome', clientId: 'c0' }) // the server is really there
    const second = scheduledDelay(spy, () => sockets[1]?.close())
    // Back to the floor's jitter window rather than the doubled one.
    expect(second).toBeGreaterThanOrEqual(250)
    expect(second).toBeLessThan(500)
  })

  it('connectNow skips the pending backoff and connects once', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    sockets[0]?.close()
    expect(sockets).toHaveLength(1)

    hub.connectNow()
    expect(sockets).toHaveLength(2)
    // The pending timer was cleared, so nothing opens a second socket later.
    vi.advanceTimersByTime(30_000)
    expect(sockets).toHaveLength(2)
  })

  it('connectNow resets the backoff so a later drop retries from the floor', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    const first = scheduledDelay(spy, () => sockets[0]?.close())
    vi.advanceTimersByTime(first)
    sockets[1]?.close() // still down: base is now 2000
    hub.connectNow()

    const next = scheduledDelay(spy, () => sockets.at(-1)?.close())
    expect(next).toBeGreaterThanOrEqual(250)
    expect(next).toBeLessThan(500)
  })

  it('connectNow does not open a second socket while one is connecting or open', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect() // CONNECTING: the socket exists but has not opened
    hub.connectNow()
    expect(sockets).toHaveLength(1)
    sockets[0]?.open()
    hub.connectNow()
    expect(sockets).toHaveLength(1)
  })

  it('connectNow is a no-op after dispose', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.dispose()
    hub.connectNow()
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(30_000)
    expect(sockets).toHaveLength(1)
  })
})
