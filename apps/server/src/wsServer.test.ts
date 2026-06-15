import { describe, expect, it, vi } from 'vitest'
import { type HeartbeatSocket, sweepClientLiveness } from './wsServer'

function fakeSocket(readyState = 1) {
  return { readyState, ping: vi.fn(), terminate: vi.fn() }
}

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
