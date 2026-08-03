/**
 * ONE test over the REAL transport (POD-1535).
 *
 * The other suites drive a fake hub, which proves the fold and the binding but
 * would survive the seam and the hub disagreeing about the wire. This one runs
 * a real `SocketHub` over a fake socket: the join really becomes a
 * `presenceSubscribe` frame, and a server `presenceRoomState` frame really
 * arrives in the rendered view. That is the seam POD-427 found unbuilt.
 */

import { asSessionId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocketHub, type WebSocketLike } from '../socket-transport'
import { PresenceRooms } from './room-presence'

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
  parsed(): Record<string, unknown>[] {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)
  }
}

const viewport = { cols: 80, rows: 24, dpr: 1 }

afterEach(() => {
  vi.useRealTimers()
})

describe('PresenceRooms over a real SocketHub', () => {
  it('turns a watch into a wire join, and a server occupancy frame into a readable view', () => {
    const socket = new FakeSocket()
    const hub = new SocketHub({
      url: 'ws://transport.test',
      viewport,
      makeSocket: () => socket,
      feed: { connected: vi.fn(), disconnected: vi.fn(), frame: vi.fn() },
    })
    const rooms = new PresenceRooms(hub)
    const room = { kind: 'session' as const, id: asSessionId('s-room') }

    hub.connect()
    socket.open()
    socket.sent = []

    const changes: number[] = []
    const release = rooms.subscribe(room, () => changes.push(1), { view: 'native' })

    // The join is on the wire, and it carries NO identity — the server stamps
    // that from the authenticated transport (ADR 3 D7 / D9.1).
    const subscribeFrame = socket.parsed().find((f) => f.type === 'presenceSubscribe')
    expect(subscribeFrame).toEqual({ type: 'presenceSubscribe', room })
    expect(JSON.stringify(socket.parsed())).not.toContain('identity')

    // Until the server answers, the answer is unknown — not an empty room.
    expect(rooms.view(room).status).toBe('unknown')
    expect(rooms.view(room).members).toBeUndefined()

    socket.receive({
      type: 'presenceRoomState',
      room,
      members: [{ identity: { kind: 'user', user: asUserId('u-alice') } }],
    })

    expect(changes).toHaveLength(1)
    const view = rooms.view(room)
    expect(view.status).toBe('present')
    expect(view.members?.[0]?.identity).toEqual({ kind: 'user', user: 'u-alice' })

    // And the release really leaves, on the wire.
    release()
    expect(socket.parsed().some((f) => f.type === 'presenceUnsubscribe')).toBe(true)
    hub.dispose()
  })
})
