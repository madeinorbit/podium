import type { AgentRuntimeState, Geometry, ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type ClientConn, Session } from './session'

const geo: Geometry = { cols: 80, rows: 24 }
const CREATED = '2026-06-03T00:00:00.000Z'

function state(phase: AgentRuntimeState['phase'], since: string): AgentRuntimeState {
  return { phase, since, openTaskCount: 0 }
}

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
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
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
    a.viewVisible = new Set(['s1']) // controller is rendering the session
    s.handleResize('b', 100, 30)
    expect(s.geometry).toEqual(geo)
    expect(toDaemon).not.toHaveBeenCalled()
    s.handleResize('a', 120, 40)
    expect(s.geometry).toEqual({ cols: 120, rows: 40 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 120, rows: 40 })
  })

  it('ignores a resize from a controller that isn’t rendering the session', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.attachClient(a) // controller
    a.viewVisible = new Set() // not rendering s1 (e.g. a backgrounded tab)
    s.handleResize('a', 200, 50)
    expect(s.geometry).toEqual(geo) // unchanged — its stale grid can't move the PTY
    expect(toDaemon).not.toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 200, rows: 50 })
  })

  it('applies a resize from a controller that is rendering the session', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.attachClient(a) // controller
    a.viewVisible = new Set(['s1']) // rendering s1 on screen
    s.handleResize('a', 200, 50)
    expect(s.geometry).toEqual({ cols: 200, rows: 50 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 200, rows: 50 })
  })

  it('takeover bumps epoch, resizes+redraws the agent, broadcasts controllerChanged + geometry', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    b.viewVisible = new Set(['s1']) // requester is rendering the session → snap-resizes
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

  it('requestControl from a client not rendering the session transfers control but does not snap-resize', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a)
    s.attachClient(b)
    b.viewport = { cols: 50, rows: 60 } // a stale viewport we must NOT snap to
    b.viewVisible = new Set() // requester isn't rendering s1 yet (viewState not landed)
    toDaemon.mockClear()
    s.requestControl('b')
    // Control STILL transfers — a non-rendering controller is harmless (it can't
    // resize until handleResize sees it in viewVisible).
    expect(s.controllerId).toBe('b')
    expect(s.epoch).toBe(1)
    // …but the agent is NOT sized to the requester's possibly-stale viewport.
    expect(s.geometry).toEqual(geo)
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }))
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'redraw' }))
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
    a.viewVisible = new Set(['s1']) // rendering the session → snap to its viewport
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

  it('setAgentState advances lastActiveAt to the phase event-time (state.since)', () => {
    const s = makeSession()
    expect(s.lastActiveAt).toBe(CREATED)
    s.setAgentState(state('working', '2026-06-04T00:00:00.000Z'))
    expect(s.lastActiveAt).toBe('2026-06-04T00:00:00.000Z')
  })

  it('setAgentState re-syncs lastActiveAt to the event-time (boot re-seed can correct a stale value down)', () => {
    // lastActiveAt tracks the phase event-time (state.since), sourced from the real
    // transcript record. A reattach re-seeds boot state from the transcript's true
    // last-activity time; if recency was wrongly bumped (e.g. a metadata write once
    // moved the file mtime), re-seeding must correct it back DOWN to the truth.
    const s = makeSession()
    s.setAgentState(state('idle', '2026-06-10T00:00:00.000Z'))
    expect(s.lastActiveAt).toBe('2026-06-10T00:00:00.000Z')
    s.setAgentState(state('idle', '2026-06-04T00:00:00.000Z')) // re-seed with the true (older) time
    expect(s.lastActiveAt).toBe('2026-06-04T00:00:00.000Z')
  })

  it('markLive (daemon reattach/bind) does NOT restamp lastActiveAt', () => {
    const s = new Session({
      sessionId: 's1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      lastActiveAt: '2026-06-10T00:00:00.000Z',
      geometry: geo,
      toDaemon: vi.fn(),
      status: 'reconnecting',
    })
    s.markLive('claude', geo)
    expect(s.lastActiveAt).toBe('2026-06-10T00:00:00.000Z')
  })

  it('setTitle does NOT restamp lastActiveAt (a title change is not activity)', () => {
    const s = makeSession()
    s.setTitle('new title')
    expect(s.title).toBe('new title')
    expect(s.lastActiveAt).toBe(CREATED)
  })

  it('a running shell command advances lastActiveAt (output is its only signal)', () => {
    const s = new Session({
      sessionId: 'sh',
      agentKind: 'shell',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      geometry: geo,
      toDaemon: vi.fn(),
    })
    s.attachClient(makeClient('a'))
    s.handleInput('a', Buffer.from('ls\r').toString('base64'))
    expect(s.lastActiveAt > CREATED).toBe(true)
  })

  it('toMeta surfaces snoozedUntil only when set; clearSnooze reports change', () => {
    const s = makeSession()
    expect('snoozedUntil' in s.toMeta()).toBe(false)
    expect(s.clearSnooze()).toBe(false)

    s.snoozedUntil = null
    expect(s.toMeta().snoozedUntil).toBeNull()

    s.snoozedUntil = '2999-01-01T05:00:00.000Z'
    expect(s.toMeta().snoozedUntil).toBe('2999-01-01T05:00:00.000Z')

    expect(s.clearSnooze()).toBe(true)
    expect('snoozedUntil' in s.toMeta()).toBe(false)
  })

  it('toMeta surfaces draftUpdatedAt only when a draft exists', () => {
    const s = makeSession()
    expect('draftUpdatedAt' in s.toMeta()).toBe(false)

    s.draftUpdatedAt = '2026-06-24T12:00:00.000Z'
    expect(s.toMeta().draftUpdatedAt).toBe('2026-06-24T12:00:00.000Z')

    s.draftUpdatedAt = undefined
    expect('draftUpdatedAt' in s.toMeta()).toBe(false)
  })
})

describe('Session transcript cache (recent-delta window)', () => {
  const item = (id: string, cursor: string, text = id) =>
    ({ id, role: 'user' as const, text, cursor }) as const

  it('applyDelta appends, fans out a transcriptDelta, and flips availability once', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.subscribeTranscript(a)
    // Empty subscribe → no replay frame.
    expect(a.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([])

    const became = s.applyDelta([item('u1', 'c1')], { tail: 'c1' })
    expect(became).toBe(true) // first transcript observed → chat capability flips on
    expect(a.sent.at(-1)).toEqual({
      type: 'transcriptDelta',
      sessionId: 's1',
      items: [item('u1', 'c1')],
      tail: 'c1',
    })
    expect(s.transcriptItems()).toEqual([item('u1', 'c1')])
    // A second delta no longer flips availability.
    expect(s.applyDelta([item('u2', 'c2')], {})).toBe(false)
    expect(s.transcriptItems()).toEqual([item('u1', 'c1'), item('u2', 'c2')])
  })

  it('applyDelta({reset}) clears the cache and fans out reset:true', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.subscribeTranscript(a)
    s.applyDelta([item('u1', 'c1')], {})
    s.applyDelta([item('u2', 'c2')], { reset: true, tail: 'c2' })
    expect(s.transcriptItems()).toEqual([item('u2', 'c2')])
    expect(a.sent.at(-1)).toEqual({
      type: 'transcriptDelta',
      sessionId: 's1',
      items: [item('u2', 'c2')],
      tail: 'c2',
      reset: true,
    })
  })

  it('subscribeTranscript(since) replays only items after since; whole cache when unknown; nothing when caught up', () => {
    const s = makeSession()
    s.applyDelta([item('a', 'c1'), item('b', 'c2'), item('c', 'c3')], { tail: 'c3' })

    const known = makeClient('k')
    s.subscribeTranscript(known, 'c1')
    expect(known.sent).toEqual([
      { type: 'transcriptDelta', sessionId: 's1', items: [item('b', 'c2'), item('c', 'c3')] },
    ])

    const stale = makeClient('s')
    s.subscribeTranscript(stale, 'older')
    expect(stale.sent).toEqual([
      {
        type: 'transcriptDelta',
        sessionId: 's1',
        items: [item('a', 'c1'), item('b', 'c2'), item('c', 'c3')],
      },
    ])

    const caught = makeClient('c')
    s.subscribeTranscript(caught, 'c3')
    expect(caught.sent).toEqual([])
  })
})
