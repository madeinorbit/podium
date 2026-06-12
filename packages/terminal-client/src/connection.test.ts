import { encode, type ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocketHub, type WebSocketLike } from './connection'

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

  it('captures the server-assigned clientId from welcome', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    sock.recv({ type: 'welcome', clientId: 'c0' })
    expect(hub.clientId).toBe('c0')
  })

  it('exposes sessionsChanged via sessions() + onSessions', () => {
    const { sock, hub } = setup()
    const seen: number[] = []
    hub.onSessions((s) => seen.push(s.length))
    hub.connect()
    sock.open()
    const meta = {
      sessionId: 's1',
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
    }
    sock.recv({ type: 'sessionsChanged', sessions: [meta] })
    expect(hub.sessions()).toEqual([meta])
    expect(seen.at(-1)).toBe(1)
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
      sessionId: 's1',
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
    }
    const titles: string[] = []
    hub.onSessions((s) => {
      if (s[0]) titles.push(s[0].title)
    })
    hub.connect()
    sock.open()
    sock.recv({ type: 'sessionsChanged', sessions: [meta] })
    sock.recv({ type: 'sessionTitleChanged', sessionId: 's1', title: '⠹ podium' })
    expect(hub.sessions().at(0)?.title).toBe('⠹ podium')
    expect(titles.at(-1)).toBe('⠹ podium')
    // An unchanged title doesn't churn observers.
    const count = titles.length
    sock.recv({ type: 'sessionTitleChanged', sessionId: 's1', title: '⠹ podium' })
    expect(titles.length).toBe(count)
    // A title for an unknown session is ignored.
    sock.recv({ type: 'sessionTitleChanged', sessionId: 'ghost', title: 'x' })
    expect(titles.length).toBe(count)
  })

  it('attach sends an attach message and returns a SessionConnection', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const conn = hub.attach('s1')
    expect(conn.sessionId).toBe('s1')
    expect(sock.parsed()).toContainEqual({ type: 'attach', sessionId: 's1' })
  })

  it('re-sends attach for existing connections on reconnect (open)', () => {
    const { sock, hub } = setup()
    hub.attach('s1') // attached before connect
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
    const f1: string[] = []
    const f2: string[] = []
    hub.attach('s1', { onFrame: (t) => f1.push(t) })
    hub.attach('s2', { onFrame: (t) => f2.push(t) })
    sock.recv({ type: 'outputFrame', sessionId: 's1', seq: 0, epoch: 0, data: b64('one') })
    sock.recv({ type: 'outputFrame', sessionId: 's2', seq: 0, epoch: 0, data: b64('two') })
    expect(f1).toEqual(['one'])
    expect(f2).toEqual(['two'])
  })

  it('drops session-scoped messages for unknown sessions without throwing', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    expect(() =>
      sock.recv({ type: 'outputFrame', sessionId: 'ghost', seq: 0, epoch: 0, data: b64('x') }),
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
    const conn = hub.attach('s1')
    sock.recv({
      type: 'attached',
      sessionId: 's1',
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
      sessionId: 's1',
      controllerId: 'c9',
      geometry: { cols: 90, rows: 30 },
    })
    expect(conn.state().role).toBe('spectator')
  })

  it('tags input/resize/requestControl/redraw with the sessionId', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const conn = hub.attach('s1')
    conn.sendInput('x')
    conn.sendResize(120, 40)
    conn.requestControl()
    conn.redraw()
    const sent = sock.parsed()
    expect(sent).toContainEqual({ type: 'input', sessionId: 's1', data: b64('x') })
    expect(sent).toContainEqual({ type: 'resize', sessionId: 's1', cols: 120, rows: 40 })
    expect(sent).toContainEqual({ type: 'requestControl', sessionId: 's1' })
    expect(sent).toContainEqual({ type: 'redrawRequest', sessionId: 's1' })
  })

  it('updates lastSeq/epoch and emits the decoded frame', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const frames: string[] = []
    const conn = hub.attach('s1', { onFrame: (t) => frames.push(t) })
    sock.recv({ type: 'outputFrame', sessionId: 's1', seq: 5, epoch: 2, data: b64('hello') })
    expect(frames).toEqual(['hello'])
    expect(conn.state()).toMatchObject({ lastSeq: 5, epoch: 2 })
  })

  it('applies geometry updates', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const conn = hub.attach('s1')
    sock.recv({ type: 'geometry', sessionId: 's1', cols: 111, rows: 41 })
    expect(conn.state()).toMatchObject({ cols: 111, rows: 41 })
  })

  it('handles agentExit without throwing and still emits state', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const states: string[] = []
    hub.attach('s1', { onState: (s) => states.push(s.role) })
    expect(() => sock.recv({ type: 'agentExit', sessionId: 's1', code: 0 })).not.toThrow()
    expect(states.length).toBeGreaterThan(0)
  })

  it('re-attach updates callbacks without sending a second attach', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    hub.attach('s1')
    const before = sock.parsed().filter((m) => m.type === 'attach' && m.sessionId === 's1').length
    const frames: string[] = []
    hub.attach('s1', { onFrame: (t) => frames.push(t) })
    const after = sock.parsed().filter((m) => m.type === 'attach' && m.sessionId === 's1').length
    expect(after).toBe(before) // no duplicate attach
    sock.recv({ type: 'outputFrame', sessionId: 's1', seq: 0, epoch: 0, data: btoa('hi') })
    expect(frames).toEqual(['hi'])
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

  it('reconnects after an unintentional close and re-attaches sessions', () => {
    vi.useFakeTimers()
    const { sockets, hub } = multiSetup()
    hub.connect()
    sockets[0]?.open()
    hub.attach('s1')
    sockets[0]?.close() // backend died / proxy dropped the socket
    expect(hub.connected).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(sockets.length).toBe(2)
    sockets[1]?.open()
    expect(hub.connected).toBe(true)
    expect(sockets[1]?.parsed()).toContainEqual({ type: 'attach', sessionId: 's1' })
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
