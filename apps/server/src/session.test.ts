import type { Geometry, ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type ClientConn, Session } from './session'

const geo: Geometry = { cols: 80, rows: 24 }

function makeSession(toDaemon = vi.fn()) {
  return new Session({
    sessionId: 's1',
    agentKind: 'claude-code',
    cwd: '/w',
    title: 'w',
    origin: { kind: 'spawn' },
    createdAt: '2026-06-03T00:00:00.000Z',
    geometry: geo,
    toDaemon,
  })
}
function makeClient(id: string): ClientConn & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  return { id, send: (m) => sent.push(m), viewport: { ...geo }, attached: new Set(), sent }
}

describe('Session', () => {
  it('first attached client becomes controller and gets an attached snapshot', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    expect(s.controllerId).toBe('a')
    expect(a.sent).toContainEqual({
      type: 'attached',
      sessionId: 's1',
      controllerId: 'a',
      geometry: geo,
      epoch: 0,
    })
  })

  it('a second client attaches as spectator', () => {
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    expect(s.controllerId).toBe('a')
    expect(b.sent.at(-1)).toMatchObject({ type: 'attached', controllerId: 'a' })
  })

  it('honors input only from the controller', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    s.handleInput('b', 'eA==')
    expect(toDaemon).not.toHaveBeenCalled()
    s.handleInput('a', 'eA==')
    expect(toDaemon).toHaveBeenCalledWith({ type: 'input', sessionId: 's1', data: 'eA==' })
  })

  it('controller resize updates geometry + resizes agent; spectator resize is stored only', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    s.handleResize('b', 100, 30)
    expect(s.geometry).toEqual(geo)
    expect(toDaemon).not.toHaveBeenCalled()
    s.handleResize('a', 120, 40)
    expect(s.geometry).toEqual({ cols: 120, rows: 40 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 120, rows: 40 })
  })

  it('takeover bumps epoch, resizes+redraws the agent, broadcasts controllerChanged + geometry', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    s.handleResize('b', 50, 60)
    s.requestControl('b')
    expect(s.controllerId).toBe('b')
    expect(s.epoch).toBe(1)
    expect(s.geometry).toEqual({ cols: 50, rows: 60 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 50, rows: 60 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'redraw', sessionId: 's1' })
    for (const c of [a, b]) {
      expect(c.sent).toContainEqual({
        type: 'controllerChanged',
        sessionId: 's1',
        controllerId: 'b',
        geometry: { cols: 50, rows: 60 },
      })
      expect(c.sent).toContainEqual({ type: 'geometry', sessionId: 's1', cols: 50, rows: 60 })
    }
  })

  it('broadcasts frames to attached clients with the current epoch', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    s.onFrame(7, 'ZGF0YQ==')
    expect(a.sent).toContainEqual({
      type: 'outputFrame',
      sessionId: 's1',
      seq: 7,
      epoch: 0,
      data: 'ZGF0YQ==',
    })
  })

  it('reassigns controller when the controller detaches', () => {
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    s.detachClient('a')
    expect(s.controllerId).toBe('b')
    expect(b.sent).toContainEqual(
      expect.objectContaining({ type: 'controllerChanged', controllerId: 'b' }),
    )
  })

  it('marks exited and broadcasts agentExit', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    s.onExit(0)
    expect(s.status).toBe('exited')
    expect(a.sent).toContainEqual({ type: 'agentExit', sessionId: 's1', code: 0 })
    expect(s.toMeta()).toMatchObject({ status: 'exited', exitCode: 0 })
  })
})
