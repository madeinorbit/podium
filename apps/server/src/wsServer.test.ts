import { encode } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type HeartbeatSocket, safeSend, safeSendEncoded, sweepClientLiveness } from './wsServer'

function fakeSocket(readyState = 1) {
  return { readyState, ping: vi.fn(), terminate: vi.fn() }
}

function fakeSendSocket(over: { readyState?: number; bufferedAmount?: number } = {}) {
  return {
    readyState: over.readyState ?? 1,
    bufferedAmount: over.bufferedAmount ?? 0,
    send: vi.fn<(data: string) => void>(),
    terminate: vi.fn<() => void>(),
  }
}

describe('safeSend', () => {
  const msg = { type: 'pong' } as const
  const LIMIT = 1000

  it('encodes and sends when the socket is OPEN and under the buffer limit', () => {
    const ws = fakeSendSocket({ bufferedAmount: 10 })
    safeSend(ws, msg, LIMIT)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(ws.send).toHaveBeenCalledWith(encode(msg))
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('sends already-prepared publication bytes without encoding them again', () => {
    const ws = fakeSendSocket()
    const bytes = '{"type":"sessionsChanged","sessions":[]}'
    safeSendEncoded(ws, bytes, LIMIT)
    expect(ws.send).toHaveBeenCalledWith(bytes)
  })

  it('terminates (does not send) a slow socket whose send buffer exceeds the limit', () => {
    const ws = fakeSendSocket({ bufferedAmount: LIMIT + 1 })
    safeSend(ws, msg, LIMIT)
    expect(ws.send).not.toHaveBeenCalled()
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('does nothing for a socket that is not OPEN', () => {
    const ws = fakeSendSocket({ readyState: 0 /* CONNECTING */ })
    safeSend(ws, msg, LIMIT)
    expect(ws.send).not.toHaveBeenCalled()
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('swallows a throwing send (socket died mid-send) without rethrowing or terminating', () => {
    const ws = fakeSendSocket()
    ws.send.mockImplementation(() => {
      throw new Error('WebSocket is not open')
    })
    expect(() => safeSend(ws, msg, LIMIT)).not.toThrow()
    expect(ws.terminate).not.toHaveBeenCalled()
  })
})

describe('sweepClientLiveness', () => {
  it('pings a live (alive-marked) socket and clears its mark', () => {
    const ws = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([ws])
    sweepClientLiveness([ws], alive)
    expect(ws.ping).toHaveBeenCalledOnce()
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(alive.has(ws)).toBe(false) // mark cleared — must pong again to survive next sweep
  })

  it('terminates a socket that did not pong since the previous sweep', () => {
    const ws = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([ws])
    sweepClientLiveness([ws], alive) // pings, clears mark
    sweepClientLiveness([ws], alive) // no pong arrived → reaped
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('a socket that pongs between sweeps survives', () => {
    const ws = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([ws])
    sweepClientLiveness([ws], alive) // clears mark
    alive.add(ws) // pong handler re-marks it
    sweepClientLiveness([ws], alive)
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(ws.ping).toHaveBeenCalledTimes(2)
  })

  it('does not ping a socket that is not OPEN', () => {
    const ws = fakeSocket(0 /* CONNECTING */)
    const alive = new WeakSet<HeartbeatSocket>([ws])
    sweepClientLiveness([ws], alive)
    expect(ws.ping).not.toHaveBeenCalled()
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('a ping that throws (socket vanished mid-sweep) does not abort the sweep', () => {
    const bad = fakeSocket()
    bad.ping.mockImplementation(() => {
      throw new Error('WebSocket is not open')
    })
    const good = fakeSocket()
    const alive = new WeakSet<HeartbeatSocket>([bad, good])
    expect(() => sweepClientLiveness([bad, good], alive)).not.toThrow()
    expect(good.ping).toHaveBeenCalledOnce()
  })
})
