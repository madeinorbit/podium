import { asSessionId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocketHub, type WebSocketLike } from './socket-hub'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  bufferedAmount = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.onclose?.({})
  }

  open(): void {
    this.onopen?.({})
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)
  }
}

const viewport = { cols: 80, rows: 24, dpr: 1 }

afterEach(() => {
  vi.useRealTimers()
})

describe('SocketHub rooms and principal lifecycle', () => {
  it('shares one durable/lossy registry, maps visibility forward, and never sends identity', () => {
    const socket = new FakeSocket()
    const hub = new SocketHub({
      url: 'ws://transport.test',
      viewport,
      makeSocket: () => socket,
      feed: {
        connected: vi.fn(),
        disconnected: vi.fn(),
        frame: vi.fn(),
      },
    })
    const room = { kind: 'session' as const, id: asSessionId('s-room') }
    const roomStates: unknown[] = []
    hub.on('presenceRoomState', (frame) => roomStates.push(frame))

    hub.connect()
    socket.open()
    socket.sent = []
    hub.subscribeRoom(room, { cursor: { row: 3, col: 7 } })
    hub.setVisible(false)

    expect(hub.subscriptionSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ durability: 'durable' }),
        expect.objectContaining({ durability: 'ephemeral', room }),
      ]),
    )

    const outbound = socket.parsed()
    expect(outbound.some((frame) => frame.type === 'presence')).toBe(false)
    for (const frame of outbound.filter((item) => String(item.type).startsWith('presence'))) {
      expect(frame).not.toHaveProperty('identity')
      expect(frame).not.toHaveProperty('user')
      expect(frame).not.toHaveProperty('name')
      expect(frame).not.toHaveProperty('actor')
    }

    socket.receive({
      type: 'presenceRoomState',
      room,
      members: [{ identity: { kind: 'user', user: asUserId('user:one') }, visible: true }],
    })
    expect(roomStates).toHaveLength(1)
    hub.dispose()
  })

  it('drops presence under pressure without delaying a control frame', () => {
    const socket = new FakeSocket()
    const hub = new SocketHub({
      url: 'ws://transport.test',
      viewport,
      makeSocket: () => socket,
    })
    const room = { kind: 'session' as const, id: asSessionId('s-room') }

    hub.subscribeRoom(room)
    hub.connect()
    socket.open()
    socket.sent = []
    socket.bufferedAmount = 64 * 1024

    expect(hub.publishPresence(room, { cursor: 9 })).toBe(false)
    hub.setViewState([room.id], room.id)

    expect(socket.parsed()).toEqual([{ type: 'viewState', visible: [room.id], focused: room.id }])
    hub.dispose()
  })

  it('reconnects with PTY seq, spectator/controller identity, room membership, and presence', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const hub = new SocketHub({
      url: 'ws://transport.test',
      viewport,
      makeSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const sessionId = asSessionId('s-chaos')
    const room = { kind: 'session' as const, id: sessionId }
    const connection = hub.attach(sessionId)
    hub.subscribeRoom(room, { cursor: 4 })
    hub.setVisible(false)

    hub.connect()
    const first = sockets[0] as FakeSocket
    first.open()
    first.receive({ type: 'welcome', clientId: 'client-one' })
    first.receive({
      type: 'attached',
      sessionId,
      controllerId: 'client-one',
      controllerIdentity: { kind: 'user', user: asUserId('user:one') },
      geometry: { cols: 80, rows: 24 },
      epoch: 4,
    })
    first.receive({
      type: 'outputFrame',
      sessionId,
      seq: 17,
      epoch: 4,
      data: btoa('ready'),
    })
    first.receive({
      type: 'controllerChanged',
      sessionId,
      controllerId: 'client-two',
      controllerIdentity: { kind: 'user', user: asUserId('user:two') },
      geometry: { cols: 100, rows: 30 },
    })

    first.close()
    vi.advanceTimersByTime(500)
    const second = sockets[1] as FakeSocket
    second.open()

    expect(second.parsed()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'attach', sessionId, sinceSeq: 17 }),
        { type: 'presenceSubscribe', room },
        { type: 'presenceUpdate', room, payload: { cursor: 4 }, visible: false },
      ]),
    )
    expect(connection.state()).toMatchObject({
      role: 'spectator',
      epoch: 4,
      lastSeq: 17,
      controllerId: 'client-two',
      controllerIdentity: { kind: 'user', user: asUserId('user:two') },
    })
    hub.dispose()
  })

  it('does not retry unauthorized attaches and keeps unreachable distinct', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const outcomes: string[] = []
    const unauthorized = asSessionId('s-denied')
    const unreachable = asSessionId('s-offline')
    const hub = new SocketHub({
      url: 'ws://transport.test',
      viewport,
      makeSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })

    hub.attach(unauthorized, { onOutcome: (outcome) => outcomes.push(outcome) })
    hub.attach(unreachable, { onOutcome: (outcome) => outcomes.push(outcome) })
    hub.connect()
    const first = sockets[0] as FakeSocket
    first.open()
    first.receive({ type: 'terminalOutcome', sessionId: unauthorized, outcome: 'unauthorized' })
    first.receive({ type: 'terminalOutcome', sessionId: unreachable, outcome: 'unreachable' })
    expect(outcomes).toEqual(['unauthorized', 'unreachable'])

    first.close()
    vi.advanceTimersByTime(500)
    const second = sockets[1] as FakeSocket
    second.open()
    const attaches = second
      .parsed()
      .filter((frame) => frame.type === 'attach')
      .map((frame) => frame.sessionId)

    expect(attaches).toEqual([unreachable])
    hub.dispose()
  })

  it('releases all principal-bound attach and room state before a replacement hub', () => {
    const firstSocket = new FakeSocket()
    const first = new SocketHub({
      url: 'ws://transport.test',
      viewport,
      makeSocket: () => firstSocket,
    })
    const sessionId = asSessionId('s-old-principal')
    first.attach(sessionId)
    first.subscribeRoom({ kind: 'session', id: sessionId })
    first.connect()
    firstSocket.open()
    first.releasePrincipal()

    expect(first.subscriptionSnapshot()).toEqual([])

    const nextSocket = new FakeSocket()
    const next = new SocketHub({
      url: 'ws://transport.test',
      viewport,
      makeSocket: () => nextSocket,
    })
    next.connect()
    nextSocket.open()
    expect(
      nextSocket
        .parsed()
        .filter((frame) =>
          ['attach', 'presenceSubscribe', 'presenceUpdate'].includes(String(frame.type)),
        ),
    ).toEqual([])
    next.dispose()
  })
})
