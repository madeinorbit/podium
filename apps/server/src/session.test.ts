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
    caps: new Set(),
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
    sent,
  }
}

describe('Session unread (#124)', () => {
  it('toMeta surfaces readAt (null when never opened) and derives unread', () => {
    const s = makeSession()
    // Never opened: readAt null, and lastActiveAt (defaults to createdAt) counts as
    // unseen activity → unread.
    expect(s.toMeta().readAt).toBeNull()
    expect(s.toMeta().unread).toBe(true)
    // Opened AFTER the last activity → read.
    s.readAt = '2026-06-03T01:00:00.000Z'
    expect(s.toMeta().readAt).toBe('2026-06-03T01:00:00.000Z')
    expect(s.toMeta().unread).toBe(false)
    // Opened BEFORE the last activity → unread again.
    s.readAt = '2026-06-02T00:00:00.000Z'
    expect(s.toMeta().unread).toBe(true)
  })
})

describe('Session stop report (#146)', () => {
  const report = {
    outcome: 'partial' as const,
    need: 'decision' as const,
    attention: 'soon' as const,
    summary: 'billing needs a call',
    at: '2026-07-08T12:00:00.000Z',
  }

  it('setStopReport surfaces on toMeta and serialises to toRow; clearStopReport drops it', () => {
    const s = makeSession()
    expect(s.toMeta().stopReport).toBeUndefined()
    expect(s.toRow().stopReport).toBeNull()

    s.setStopReport(report)
    expect(s.toMeta().stopReport).toEqual(report)
    expect(JSON.parse(s.toRow().stopReport as string)).toEqual(report)

    expect(s.clearStopReport()).toBe(true)
    expect(s.toMeta().stopReport).toBeUndefined()
    // A second clear is a no-op (lets callers skip a redundant broadcast).
    expect(s.clearStopReport()).toBe(false)
  })

  it('parseStopReport is defensive — malformed or out-of-schema JSON reads as no report', () => {
    expect(Session.parseStopReport(null)).toBeUndefined()
    expect(Session.parseStopReport('not json{')).toBeUndefined()
    expect(Session.parseStopReport('{"outcome":"nope"}')).toBeUndefined()
    expect(Session.parseStopReport(JSON.stringify(report))).toEqual(report)
  })
})

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
    expect(toDaemon).not.toHaveBeenCalledWith({
      type: 'resize',
      sessionId: 's1',
      cols: 200,
      rows: 50,
    })
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

  it('broadcasts the applied geometry to all clients so the size is not lost (quarter-size fix)', () => {
    // The client only learns the authoritative size from a geometry/controllerChanged/
    // attached message — its own optimistic sendResize value gets clobbered by
    // requestControl's geometry broadcast. So an applied resize MUST broadcast, or the
    // xterm snaps back to 80x24 via onState even though the PTY was resized.
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a) // controller
    s.attachClient(b) // spectator (e.g. another device)
    a.viewVisible = new Set(['s1'])
    a.sent.length = 0
    b.sent.length = 0
    s.handleResize('a', 200, 50)
    for (const c of [a, b]) {
      expect(c.sent).toContainEqual({ type: 'geometry', sessionId: 's1', cols: 200, rows: 50 })
    }
  })

  it('reconcileGeometry broadcasts the healed geometry to clients', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.attachClient(a)
    a.viewport = { cols: 200, rows: 50 } // last fitted size (handleResize stored it, then dropped)
    a.viewVisible = new Set(['s1']) // viewState now confirms it renders s1
    a.sent.length = 0
    s.reconcileGeometry('a')
    expect(s.geometry).toEqual({ cols: 200, rows: 50 })
    expect(a.sent).toContainEqual({ type: 'geometry', sessionId: 's1', cols: 200, rows: 50 })
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

  it('re-requesting control as the current controller is a no-op (no epoch bump → no reveal-clear)', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.attachClient(a) // a is the controller
    a.viewVisible = new Set(['s1'])
    const epoch0 = s.epoch
    a.sent.length = 0
    toDaemon.mockClear()
    s.requestControl('a') // re-claim control it already holds (e.g. becomeEligible on reveal)
    // No epoch bump → clients don't view.clear(); no takeover broadcasts; no agent redraw.
    expect(s.epoch).toBe(epoch0)
    expect(s.controllerId).toBe('a')
    expect(a.sent).not.toContainEqual(expect.objectContaining({ type: 'controllerChanged' }))
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'redraw' }))
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

  it('re-applies a foreground resize that arrived before its viewState (no stuck quarter-size)', () => {
    // Repro of the quarter-size bug: on a live foreground the client sends
    // requestControl + the fitted resize from the panel's React effect BEFORE the
    // store's effect sends the viewState message (child effects fire before parent
    // effects). So the resize hits handleResize while viewVisible is still empty and
    // is dropped — and nothing re-sends it. The size must self-heal when viewState
    // lands, or the PTY is stuck at the 80x24 default.
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.attachClient(a) // controller; viewVisible still empty (viewState not landed yet)
    s.requestControl('a')
    s.handleResize('a', 200, 50) // the fitted size — dropped by the viewVisible gate
    expect(s.geometry).toEqual(geo) // confirmed gated out (still default)
    toDaemon.mockClear()
    // viewState arrives: the client now declares it renders s1 on screen.
    a.viewVisible = new Set(['s1'])
    s.reconcileGeometry('a')
    // The dropped fitted size is now applied — not lost.
    expect(s.geometry).toEqual({ cols: 200, rows: 50 })
    expect(toDaemon).toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 200, rows: 50 })
  })

  it('reconcileGeometry is a no-op when the client is not the controller or not rendering', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a) // controller
    s.attachClient(b) // spectator
    b.viewport = { cols: 200, rows: 50 }
    b.viewVisible = new Set(['s1'])
    toDaemon.mockClear()
    s.reconcileGeometry('b') // not the controller → nothing
    expect(s.geometry).toEqual(geo)
    a.viewport = { cols: 200, rows: 50 }
    a.viewVisible = new Set() // controller but not rendering → nothing
    s.reconcileGeometry('a')
    expect(s.geometry).toEqual(geo)
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }))
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

  it('takeover uses the new controller current viewport (e.g. updated via hello after attach)', () => {
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.attachClient(a) // a is the initial controller
    s.attachClient(b)
    b.viewVisible = new Set(['s1']) // b renders the session → snap to its viewport on takeover
    b.viewport = { cols: 33, rows: 21 } // registry updates ClientConn.viewport on hello
    s.requestControl('b') // genuine takeover (b was NOT the controller)
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

  it('setAgentState never regresses lastActiveAt (a stale-timestamped seed must not sink the session)', () => {
    // lastActiveAt advances with the phase event-time but is MONOTONIC: a boot
    // re-seed that classified the wrong transcript (a subagent jsonl registered
    // under the parent's id, issue #94) carries an older event-time and must not
    // drag the session down the recency order. The state itself still updates.
    const s = makeSession()
    s.setAgentState(state('idle', '2026-06-10T00:00:00.000Z'))
    expect(s.lastActiveAt).toBe('2026-06-10T00:00:00.000Z')
    s.setAgentState(state('idle', '2026-06-04T00:00:00.000Z')) // stale re-seed
    expect(s.lastActiveAt).toBe('2026-06-10T00:00:00.000Z')
    expect(s.agentState?.since).toBe('2026-06-04T00:00:00.000Z')
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

  it('handleInput from the controller bumps lastInputAt and marks dirty', () => {
    const s = makeSession()
    // First attach makes this client the controller (see attachClient).
    s.attachClient(makeClient('c'))
    expect(s.lastInputAtMs).toBe(0)
    s.handleInput('c', Buffer.from('x').toString('base64'))
    expect(s.lastInputAtMs).toBeGreaterThan(0)
    expect(s.activityDirty).toBe(true)
  })

  it('markResumed bumps lastResumedAt and marks dirty without touching lastActiveAt', () => {
    const s = new Session({
      sessionId: 's1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      geometry: geo,
      toDaemon: vi.fn(),
      lastActiveAt: '2026-06-01T00:00:00.000Z',
    })
    s.markResumed()
    expect(s.lastResumedAtMs).toBeGreaterThan(0)
    expect(s.activityDirty).toBe(true)
    expect(s.lastActiveAt).toBe('2026-06-01T00:00:00.000Z') // recency untouched
  })

  it('toRow serializes the counters as ISO (null when never set)', () => {
    const s = makeSession()
    expect(s.toRow().lastOutputAt).toBeNull()
    s.markResumed()
    const iso = s.toRow().lastResumedAt
    expect(iso).not.toBeNull()
    expect(Number.isNaN(Date.parse(iso as string))).toBe(false)
  })

  it('seeds counters from SessionInit ISO values', () => {
    const s = new Session({
      sessionId: 's1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      geometry: geo,
      toDaemon: vi.fn(),
      lastInputAt: '2026-06-29T02:00:00.000Z',
    })
    expect(s.lastInputAtMs).toBe(Date.parse('2026-06-29T02:00:00.000Z'))
    expect(s.clearActivityDirty).toBeTypeOf('function')
    s.clearActivityDirty()
    expect(s.activityDirty).toBe(false)
  })

  it('seeds a malformed activity ISO as 0 (never NaN — would freeze hibernation)', () => {
    const s = new Session({
      sessionId: 's1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      geometry: geo,
      toDaemon: vi.fn(),
      lastOutputAt: 'not-a-date',
      lastInputAt: 'garbage',
      lastResumedAt: '',
    })
    // A NaN seed would make Math.max(..., NaN) === NaN and keep the session
    // awake forever; the guard must fall back to 0 instead.
    expect(s.lastOutputAtMs).toBe(0)
    expect(s.lastInputAtMs).toBe(0)
    expect(s.lastResumedAtMs).toBe(0)
    // 0 serializes back to null, so a bad value doesn't poison the persisted row.
    expect(s.toRow().lastOutputAt).toBeNull()
    expect(s.toRow().lastInputAt).toBeNull()
    expect(s.toRow().lastResumedAt).toBeNull()
  })
})
