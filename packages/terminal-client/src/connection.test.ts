import { encode, type ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SocketHub, type WebSocketLike } from './connection'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
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
      origin: { kind: 'spawn' as const },
    }
    sock.recv({ type: 'sessionsChanged', sessions: [meta] })
    expect(hub.sessions()).toEqual([meta])
    expect(seen.at(-1)).toBe(1)
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
})
