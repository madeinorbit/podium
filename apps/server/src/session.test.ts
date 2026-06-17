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
  return {
    id,
    send: (m) => sent.push(m),
    viewport: { ...geo },
    attached: new Set(),
    visible: true,
    sent,
  }
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
      resumed: false,
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

  it('shell is busy only while a submitted command runs, not on prompt-draw/echo', () => {
    const s = new Session({
      sessionId: 'sh',
      agentKind: 'shell',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: '2026-06-03T00:00:00.000Z',
      geometry: geo,
      toDaemon: vi.fn(),
    })
    const a = makeClient('a')
    s.attachClient(a) // becomes controller
    // The shell drawing its prompt (output with no command submitted) is idle.
    s.onFrame('cHJvbXB0') // "prompt"
    expect(s.toMeta().busy).toBeUndefined()
    // A keystroke that isn't Enter (and its echo) also stays idle.
    s.handleInput('a', Buffer.from('l').toString('base64'))
    s.onFrame('bA==') // echoed "l"
    expect(s.toMeta().busy).toBeUndefined()
    // Submitting a line (Enter) starts a command → busy, even before output.
    s.handleInput('a', Buffer.from('s\r').toString('base64'))
    expect(s.toMeta().busy).toBe(true)
    s.onFrame('b3V0cHV0') // command output keeps it busy
    expect(s.toMeta().busy).toBe(true)
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

  it('broadcasts frames to attached clients with a server-assigned monotonic seq', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    s.onFrame('ZGF0YQ==')
    s.onFrame('ZGF0Yg==')
    const frames = a.sent.filter((m) => m.type === 'outputFrame')
    // The Session numbers frames itself (0,1,…), ignoring the bridge's own seq, so
    // the client's resume cursor stays stable across daemon reattaches.
    expect(frames).toEqual([
      { type: 'outputFrame', sessionId: 's1', seq: 0, epoch: 0, data: 'ZGF0YQ==' },
      { type: 'outputFrame', sessionId: 's1', seq: 1, epoch: 0, data: 'ZGF0Yg==' },
    ])
  })

  it('resumes from a cursor: replays only newer frames and marks the attach resumed', () => {
    const s = makeSession()
    s.onFrame('YQ==') // seq 0
    s.onFrame('Yg==') // seq 1
    s.onFrame('Yw==') // seq 2
    const a = makeClient('a')
    s.attachClient(a, 1) // client last rendered seq 1
    const attached = a.sent.find((m) => m.type === 'attached')
    expect(attached).toMatchObject({ type: 'attached', resumed: true })
    const frames = a.sent.filter((m) => m.type === 'outputFrame')
    expect(frames).toEqual([
      { type: 'outputFrame', sessionId: 's1', seq: 2, epoch: 0, data: 'Yw==' },
    ])
  })

  it('a caught-up client resumes with zero frames (no needless wipe)', () => {
    const s = makeSession()
    s.onFrame('YQ==') // seq 0
    const a = makeClient('a')
    s.attachClient(a, 0)
    expect(a.sent.find((m) => m.type === 'attached')).toMatchObject({ resumed: true })
    expect(a.sent.filter((m) => m.type === 'outputFrame')).toEqual([])
  })

  it('falls back to a full replay (resumed:false) when the cursor outran the buffer', () => {
    const s = makeSession()
    s.onFrame('YQ==') // seq 0
    s.onFrame('Yg==') // seq 1
    const a = makeClient('a')
    // Cursor 99 is beyond anything we hold (e.g. after a server restart reset seq):
    // replay everything and tell the client to clear.
    s.attachClient(a, 99)
    expect(a.sent.find((m) => m.type === 'attached')).toMatchObject({ resumed: false })
    expect(a.sent.filter((m) => m.type === 'outputFrame')).toHaveLength(2)
  })

  it('a fresh attach (no cursor) is a full replay', () => {
    const s = makeSession()
    s.onFrame('YQ==')
    const a = makeClient('a')
    s.attachClient(a)
    expect(a.sent.find((m) => m.type === 'attached')).toMatchObject({ resumed: false })
    expect(a.sent.filter((m) => m.type === 'outputFrame')).toHaveLength(1)
  })

  it('reassignController moves the role from a stale client to its reconnected self', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    expect(s.controllerId).toBe('a')
    s.reassignController('a', 'a2')
    expect(s.controllerId).toBe('a2')
    // No-op when the named client isn't the controller.
    s.reassignController('ghost', 'x')
    expect(s.controllerId).toBe('a2')
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

  it('takeover uses the client current viewport (e.g. updated via hello after attach)', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    a.viewport = { cols: 33, rows: 21 } // registry updates ClientConn.viewport on hello
    s.requestControl('a')
    expect(s.geometry).toEqual({ cols: 33, rows: 21 })
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

  it('markLive promotes a reconnecting session to live', () => {
    const s = new Session({
      sessionId: 's1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: '2026-06-03T00:00:00.000Z',
      geometry: geo,
      toDaemon: vi.fn(),
      status: 'reconnecting',
    })
    expect(s.toMeta().status).toBe('reconnecting')
    s.markLive('claude', geo)
    expect(s.toMeta().status).toBe('live')
  })

  it('serializes to a persistable row, defaulting durableLabel/lastActiveAt', () => {
    const s = makeSession()
    expect(s.toRow()).toMatchObject({
      id: 's1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'starting',
      exitCode: null,
      durableLabel: 'podium-s1',
      createdAt: '2026-06-03T00:00:00.000Z',
      lastActiveAt: '2026-06-03T00:00:00.000Z',
    })
    s.onExit(3)
    expect(s.toRow()).toMatchObject({ status: 'exited', exitCode: 3 })
  })
})
