import { encode, parseClientMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionConnection, type WebSocketLike } from './connection'

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  deliver(serverMsgJson: string): void {
    this.onmessage?.({ data: serverMsgJson })
  }
  sentClient(): ReturnType<typeof parseClientMessage>[] {
    return this.sent.map((s) => parseClientMessage(s))
  }
}

function connect() {
  const sock = new FakeSocket()
  const frames: string[] = []
  const conn = new SessionConnection({
    url: 'ws://test/client',
    viewport: { cols: 80, rows: 24, dpr: 2 },
    makeSocket: () => sock,
    onFrame: (text) => frames.push(text),
  })
  conn.connect()
  sock.open()
  return { sock, conn, frames }
}

describe('SessionConnection', () => {
  it('sends hello + redrawRequest on open and marks connected', () => {
    const { sock, conn } = connect()
    const sent = sock.sentClient()
    expect(sent[0]).toEqual({ type: 'hello', clientId: '', viewport: { cols: 80, rows: 24, dpr: 2 } })
    expect(sent.some((m) => m.type === 'redrawRequest')).toBe(true)
    expect(conn.state().connected).toBe(true)
  })

  it('adopts identity + role=controller from welcome when it is the controller', () => {
    const { sock, conn } = connect()
    sock.deliver(
      encode({ type: 'welcome', clientId: 'c0', sessionId: 's1', controllerId: 'c0', geometry: { cols: 100, rows: 30 } }),
    )
    const s = conn.state()
    expect(s.clientId).toBe('c0')
    expect(s.sessionId).toBe('s1')
    expect(s.controllerId).toBe('c0')
    expect(s.role).toBe('controller')
    expect(s).toMatchObject({ cols: 100, rows: 30 })
  })

  it('decodes outputFrame data to utf8 and tracks seq + epoch', () => {
    const { sock, conn, frames } = connect()
    sock.deliver(encode({ type: 'welcome', clientId: 'c0', sessionId: 's1', controllerId: 'c0', geometry: { cols: 80, rows: 24 } }))
    sock.deliver(encode({ type: 'outputFrame', seq: 7, epoch: 2, data: 'aGVsbG8=' }))
    expect(frames.at(-1)).toBe('hello')
    expect(conn.state().lastSeq).toBe(7)
    expect(conn.state().epoch).toBe(2)
  })

  it('becomes spectator when controllerChanged names another client', () => {
    const { sock, conn } = connect()
    sock.deliver(encode({ type: 'welcome', clientId: 'c0', sessionId: 's1', controllerId: 'c0', geometry: { cols: 80, rows: 24 } }))
    sock.deliver(encode({ type: 'controllerChanged', controllerId: 'c1', geometry: { cols: 40, rows: 30 } }))
    const s = conn.state()
    expect(s.role).toBe('spectator')
    expect(s.controllerId).toBe('c1')
    expect(s).toMatchObject({ cols: 40, rows: 30 })
  })

  it('updates geometry on a geometry message', () => {
    const { sock, conn } = connect()
    sock.deliver(encode({ type: 'geometry', cols: 120, rows: 50 }))
    expect(conn.state()).toMatchObject({ cols: 120, rows: 50 })
  })

  it('sendInput base64-encodes bytes into an input message', () => {
    const { sock, conn } = connect()
    conn.sendInput('a')
    const input = sock.sentClient().find((m) => m.type === 'input')
    expect(input).toEqual({ type: 'input', data: 'YQ==' })
  })

  it('sendResize, requestControl, redraw emit the right client messages', () => {
    const { sock, conn } = connect()
    conn.sendResize(120, 40)
    conn.requestControl()
    conn.redraw()
    const types = sock.sentClient().map((m) => m.type)
    expect(sock.sentClient()).toContainEqual({ type: 'resize', cols: 120, rows: 40 })
    expect(types).toContain('requestControl')
    expect(types.filter((t) => t === 'redrawRequest').length).toBeGreaterThanOrEqual(2)
  })

  it('marks disconnected on close', () => {
    const { sock, conn } = connect()
    conn.dispose()
    expect(sock.closed).toBe(true)
    expect(conn.state().connected).toBe(false)
  })
})
