import { firstAdminMemberId } from '@podium/model'
import type { AgentRuntimeState, Geometry, SessionUserOverlay } from '@podium/model'
import { asMachineId, asSessionId, NO_SESSION_USER_STATE } from '@podium/model'
import {
  CAP_TERMINAL_OUTPUT_BINARY_V1,
  decodeBinaryEnvelope,
  PtyOutputBinaryMetadata,
  type ServerMessage,
} from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { ClientConn } from '../../gateway/client-registry'
import { testClientPrincipal } from '../../test-support/client-principal'
import { Session } from './session'

const geo: Geometry = { cols: 80, rows: 24 }
const CREATED = '2026-06-03T00:00:00.000Z'
/** Every Session names the machine it runs on (POD-318) — there is no default. */
const TEST_MACHINE = asMachineId('machine-under-test')

function state(phase: AgentRuntimeState['phase'], since: string): AgentRuntimeState {
  return { phase, since, nativeSubagentCount: 0 }
}

function makeSession(
  toDaemon = vi.fn(),
  seed: { outputCount?: number; turnPreviewEnabled?: boolean } = {},
) {
  const session = new Session({
    ownerUserId: firstAdminMemberId(),
    ...seed,
    sessionId: asSessionId('s1'),
    durableLabel: 'podium-s1',
    agentKind: 'claude-code',
    cwd: '/w',
    title: 'w',
    origin: { kind: 'spawn' },
    createdAt: '2026-06-03T00:00:00.000Z',
    geometry: geo,
    machineId: TEST_MACHINE,
    toDaemon,
  })
  // These live-output fixtures represent a daemon bound without pictures.
  session.terminal.setPictures(false)
  return session
}
function makeClient(id: string): ClientConn & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = []
  return {
    id,
    principal: testClientPrincipal(id),
    send: (m: ServerMessage) => sent.push(m),
    viewports: new Map(),
    attached: new Set(),
    caps: new Set(),
    wireVersion: 1,
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
    sent,
  }
}

describe('Session unread (#124), per VIEWER (POD-1076)', () => {
  /** The overlay a caller assembles from that user's two per-user tables. */
  const viewer = (readAt: string | null): SessionUserOverlay => ({
    readAt,
    snoozedUntil: undefined,
  })

  it('toMeta surfaces the VIEWER’s readAt and derives unread against it', () => {
    const s = makeSession()
    // Never opened: readAt null, and lastActiveAt (defaults to createdAt) counts as
    // unseen activity → unread.
    expect(s.toMeta(NO_SESSION_USER_STATE).readAt).toBeNull()
    expect(s.toMeta(NO_SESSION_USER_STATE).unread).toBe(true)
    // Opened AFTER the last activity → read.
    expect(s.toMeta(viewer('2026-06-03T01:00:00.000Z')).readAt).toBe('2026-06-03T01:00:00.000Z')
    expect(s.toMeta(viewer('2026-06-03T01:00:00.000Z')).unread).toBe(false)
    // Opened BEFORE the last activity → unread again.
    expect(s.toMeta(viewer('2026-06-02T00:00:00.000Z')).unread).toBe(true)
  })

  it('TWO viewers of ONE session get their OWN read state from the SAME session object', () => {
    // The property the whole re-key exists for, at the projection. Before
    // POD-1076 `readAt` was a field on the session, so this was not expressible:
    // there was one value and every client got it. The session is deliberately
    // shared between the two calls — a test that built two sessions would pass
    // against a design that still stored the marker on the session.
    const s = makeSession()
    const mine = s.toMeta(viewer('2026-06-03T01:00:00.000Z'))
    const yours = s.toMeta(NO_SESSION_USER_STATE)
    expect(mine.unread).toBe(false)
    expect(yours.unread).toBe(true)
    expect(mine.readAt).not.toBe(yours.readAt)
    // …and everything that is genuinely the SESSION's is identical for both.
    expect(mine.title).toBe(yours.title)
    expect(mine.lastActiveAt).toBe(yours.lastActiveAt)
  })
})

describe('Session', () => {
  it('first attached client becomes controller and gets an attached snapshot', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.terminal.attachClient(a)
    expect(s.terminal.controllerId).toBe('a')
    // Identity is stamped from the transport principal (POD-1081), never payload.
    expect(s.terminal.controllerIdentity).toEqual({
      kind: 'user',
      user: a.principal.user,
    })
    expect(a.sent).toContainEqual({
      type: 'attached',
      sessionId: asSessionId('s1'),
      controllerId: 'a',
      controllerIdentity: { kind: 'user', user: a.principal.user },
      geometry: geo,
      epoch: 0,
      resumed: true,
      outputSeen: false,
    })
  })

  it('a second client attaches as spectator', () => {
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a)
    s.terminal.attachClient(b)
    expect(s.terminal.controllerId).toBe('a')
    expect(b.sent.at(-1)).toMatchObject({ type: 'attached', controllerId: 'a' })
  })

  it('honors input only from the controller', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a)
    s.terminal.attachClient(b)
    s.terminal.handleInput('b', 'eA==')
    // Nothing a spectator does reaches the PTY. (Attaching itself nudges a repaint —
    // POD-379 — so assert on input specifically, not on "never called".)
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }))
    s.terminal.handleInput('a', 'eA==')
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'input',
      sessionId: asSessionId('s1'),
      data: 'eA==',
      inputOrigin: 'human',
    })
  })

  it('attributes accepted PTY input live and stamps it on the daemon frame', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.terminal.attachClient(a)
    const attribution = {
      actor: { kind: 'user' as const, id: a.principal.user },
      onBehalfOf: a.principal.user,
    }
    s.terminal.handleInput('a', 'eA==', attribution)
    // Live only — retained on the terminal for watchers, not a durable row.
    expect(s.terminal.lastInputAttribution).toEqual(attribution)
    expect(toDaemon).toHaveBeenCalledWith(expect.objectContaining({ type: 'input', attribution }))
  })

  it('revokeController clears identity and broadcasts controllerChanged', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.terminal.attachClient(a)
    a.sent.length = 0
    s.terminal.revokeController()
    expect(s.terminal.controllerId).toBeNull()
    expect(s.terminal.controllerIdentity).toBeNull()
    expect(a.sent).toContainEqual({
      type: 'controllerChanged',
      sessionId: asSessionId('s1'),
      controllerId: null,
      controllerIdentity: null,
      geometry: geo,
    })
  })

  it('shell is busy only while a submitted command runs, not on prompt-draw/echo', () => {
    const s = new Session({
    ownerUserId: firstAdminMemberId(),
      sessionId: asSessionId('sh'),
      durableLabel: 'podium-sh',
      agentKind: 'shell',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: '2026-06-03T00:00:00.000Z',
      geometry: geo,
      machineId: TEST_MACHINE,
      toDaemon: vi.fn(),
    })
    const a = makeClient('a')
    s.terminal.attachClient(a) // becomes controller
    // The shell drawing its prompt (output with no command submitted) is idle.
    s.terminal.onFrame('cHJvbXB0') // "prompt"
    expect(s.toMeta(NO_SESSION_USER_STATE).busy).toBeUndefined()
    // A keystroke that isn't Enter (and its echo) also stays idle.
    s.terminal.handleInput('a', Buffer.from('l').toString('base64'))
    s.terminal.onFrame('bA==') // echoed "l"
    expect(s.toMeta(NO_SESSION_USER_STATE).busy).toBeUndefined()
    // Submitting a line (Enter) starts a command → busy, even before output.
    s.terminal.handleInput('a', Buffer.from('s\r').toString('base64'))
    expect(s.toMeta(NO_SESSION_USER_STATE).busy).toBe(true)
    s.terminal.onFrame('b3V0cHV0') // command output keeps it busy
    expect(s.toMeta(NO_SESSION_USER_STATE).busy).toBe(true)
  })

  it('controller resize is forwarded to the agent; spectator resize is stored only', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a)
    s.terminal.attachClient(b)
    a.viewVisible = new Set([asSessionId('s1')]) // controller is rendering the session
    s.terminal.handleResize('b', 100, 30)
    expect(s.terminal.geometry).toEqual(geo)
    // A spectator's resize never reaches the PTY (the attach repaint of POD-379 does,
    // so this asserts on resize specifically rather than "never called").
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }))
    s.terminal.handleResize('a', 120, 40)
    expect(s.terminal.geometry).toEqual(geo) // the daemon's report moves the copy
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'resize',
      sessionId: asSessionId('s1'),
      cols: 120,
      rows: 40,
    })
  })

  it('ignores a resize from a controller that isn’t rendering the session', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.terminal.attachClient(a) // controller
    a.viewVisible = new Set() // not rendering s1 (e.g. a backgrounded tab)
    s.terminal.handleResize('a', 200, 50)
    expect(s.terminal.geometry).toEqual(geo) // unchanged — its stale grid can't move the PTY
    expect(toDaemon).not.toHaveBeenCalledWith({
      type: 'resize',
      sessionId: asSessionId('s1'),
      cols: 200,
      rows: 50,
    })
  })

  it('a report of the applied size is broadcast to all clients and marks the row dirty', () => {
    // The client learns the pty's size only from a geometry/controllerChanged/
    // attached message, so the report of a real change MUST broadcast — to the
    // spectator too — or the xterm stays at the old grid under a resized pty.
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a) // controller
    s.terminal.attachClient(b) // spectator (e.g. another device)
    a.viewVisible = new Set([asSessionId('s1')])
    a.sent.length = 0
    b.sent.length = 0
    s.terminal.handleResize('a', 200, 50)
    s.terminal.applyDaemonGeometry({ cols: 200, rows: 50 })
    expect(s.terminal.activityDirty).toBe(true) // the lazy DB copy follows
    for (const c of [a, b]) {
      expect(c.sent).toContainEqual({
        type: 'geometry',
        sessionId: asSessionId('s1'),
        cols: 200,
        rows: 50,
      })
    }
  })

  it('a viewState that reveals the controller reconciles the box it already stated', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.terminal.attachClient(a)
    a.viewports.set('s1', { cols: 200, rows: 50 }) // resize arrived before viewState
    a.viewVisible = new Set([asSessionId('s1')]) // viewState now confirms it renders s1
    toDaemon.mockClear()
    s.terminal.reconcile()
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'resize',
      sessionId: asSessionId('s1'),
      cols: 200,
      rows: 50,
    })
  })

  it('takeover bumps epoch, forwards the new box without a redraw, broadcasts controllerChanged', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a)
    s.terminal.attachClient(b)
    b.viewVisible = new Set([asSessionId('s1')]) // requester is rendering the session → snap-resizes
    s.terminal.requestControl('b', { cols: 50, rows: 60 })
    expect(s.terminal.controllerId).toBe('b')
    expect(s.terminal.epoch).toBe(1)
    expect(s.terminal.geometry).toEqual(geo) // the report moves it, not the claim
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'resize',
      sessionId: asSessionId('s1'),
      cols: 50,
      rows: 60,
    })
    expect(toDaemon).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'redraw', hard: true }),
    )
    expect(s.terminal.controllerIdentity).toEqual({ kind: 'user', user: b.principal.user })
    for (const c of [a, b]) {
      expect(c.sent).toContainEqual({
        type: 'controllerChanged',
        sessionId: asSessionId('s1'),
        controllerId: 'b',
        controllerIdentity: { kind: 'user', user: b.principal.user },
        geometry: geo,
      })
    }
  })

  it('re-requesting control as the current controller is a no-op (no epoch bump → no reveal-clear)', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.terminal.attachClient(a) // a is the controller
    a.viewVisible = new Set([asSessionId('s1')])
    const epoch0 = s.terminal.epoch
    a.sent.length = 0
    toDaemon.mockClear()
    s.terminal.requestControl('a') // re-claim control it already holds (e.g. becomeEligible on reveal)
    // No epoch bump → clients don't view.clear(); no takeover broadcasts; no agent redraw.
    expect(s.terminal.epoch).toBe(epoch0)
    expect(s.terminal.controllerId).toBe('a')
    expect(a.sent).not.toContainEqual(expect.objectContaining({ type: 'controllerChanged' }))
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'redraw' }))
  })

  it('re-requesting control with a new box forwards it without an epoch bump or a redraw', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.terminal.attachClient(a)
    a.viewVisible = new Set([asSessionId('s1')])
    const epoch0 = s.terminal.epoch
    a.sent.length = 0
    toDaemon.mockClear()

    s.terminal.requestControl('a', { cols: 62, rows: 36 })

    expect(s.terminal.epoch).toBe(epoch0)
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'resize',
      sessionId: asSessionId('s1'),
      cols: 62,
      rows: 36,
    })
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'redraw' }))
    expect(a.sent).not.toContainEqual(expect.objectContaining({ type: 'controllerChanged' }))
  })

  it('counts active native renderers per connection, not per person or attached client', () => {
    const s = makeSession()
    const desktop = makeClient('desktop')
    const phone = makeClient('phone')
    // Both fixtures represent connections and may belong to the same user; the
    // renderer policy intentionally does not collapse them like room presence.
    phone.principal = desktop.principal
    s.terminal.attachClient(desktop)
    s.terminal.attachClient(phone)
    desktop.viewVisible = new Set([asSessionId('s1')])
    desktop.viewModes = { s1: 'chat' }
    phone.viewVisible = new Set([asSessionId('s1')])
    phone.viewModes = { s1: 'native' }

    expect(s.terminal.activeNativeRenderers().map((client) => client.id)).toEqual(['phone'])

    desktop.viewModes = { s1: 'native' }
    expect(s.terminal.activeNativeRenderers().map((client) => client.id)).toEqual([
      'desktop',
      'phone',
    ])
  })

  it('requestControl from a client not rendering the session transfers control but does not snap-resize', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a)
    s.terminal.attachClient(b)
    b.viewports.set('s1', { cols: 50, rows: 60 }) // a stale viewport we must NOT snap to
    b.viewVisible = new Set() // requester isn't rendering s1 yet (viewState not landed)
    toDaemon.mockClear()
    s.terminal.requestControl('b')
    // Control STILL transfers — a non-rendering controller is harmless (it can't
    // resize until handleResize sees it in viewVisible).
    expect(s.terminal.controllerId).toBe('b')
    expect(s.terminal.epoch).toBe(1)
    // …but the agent is NOT sized to the requester's possibly-stale viewport.
    expect(s.terminal.geometry).toEqual(geo)
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
    s.terminal.attachClient(a) // controller; viewVisible still empty (viewState not landed yet)
    s.terminal.requestControl('a')
    s.terminal.handleResize('a', 200, 50) // the fitted size — dropped by the viewVisible gate
    expect(s.terminal.geometry).toEqual(geo) // confirmed gated out (still default)
    toDaemon.mockClear()
    // viewState arrives: the client now declares it renders s1 on screen.
    a.viewVisible = new Set([asSessionId('s1')])
    s.terminal.reconcile()
    // The held fitted size is now forwarded — not lost.
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'resize',
      sessionId: asSessionId('s1'),
      cols: 200,
      rows: 50,
    })
  })

  it('reconcile is a no-op when the controller is not rendering, whatever a spectator holds', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a) // controller
    s.terminal.attachClient(b) // spectator
    b.viewports.set('s1', { cols: 200, rows: 50 })
    b.viewVisible = new Set([asSessionId('s1')])
    toDaemon.mockClear()
    s.terminal.reconcile() // not the controller → nothing
    expect(s.terminal.geometry).toEqual(geo)
    a.viewports.set('s1', { cols: 200, rows: 50 })
    a.viewVisible = new Set() // controller but not rendering → nothing
    s.terminal.reconcile()
    expect(s.terminal.geometry).toEqual(geo)
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }))
  })

  it('broadcasts frames to attached clients with a server-assigned monotonic seq', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.terminal.attachClient(a)
    s.terminal.onFrame('ZGF0YQ==')
    s.terminal.onFrame('ZGF0Yg==')
    const frames = a.sent.filter((m) => m.type === 'outputFrame')
    // The server numbers output frames independently of the host connection.
    expect(frames).toEqual([
      { type: 'outputFrame', sessionId: asSessionId('s1'), seq: 0, epoch: 0, data: 'ZGF0YQ==' },
      { type: 'outputFrame', sessionId: asSessionId('s1'), seq: 1, epoch: 0, data: 'ZGF0Yg==' },
    ])
  })

  it('coalesces a source batch without losing byte order or activity counts', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.terminal.attachClient(a)
    s.terminal.onFrames(['ZDE=', 'ZDI='])

    const frames = a.sent.filter((m) => m.type === 'outputFrame')
    expect(frames).toHaveLength(1)
    expect(Buffer.from(frames[0]!.data, 'base64').toString()).toBe('d1d2')
    expect(frames[0]!.seq).toBe(0)
    expect(s.terminal.outputCount).toBe(2)
  })

  it('accepts arbitrary raw bytes as one sequence with source-frame accounting', () => {
    const s = makeSession()
    const a = makeClient('raw')
    s.terminal.attachClient(a)
    const source = [
      Uint8Array.from([0x00, 0xff, 0xe2]),
      Uint8Array.from([0x82]),
      Uint8Array.from([0xac, 0x1b, 0x5b, 0x32, 0x4a]),
    ]
    const bytes = Buffer.concat(source)
    s.terminal.acceptOutput(bytes, source.length)

    const frames = a.sent.filter((message) => message.type === 'outputFrame')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ seq: 0, epoch: 0 })
    if (frames[0]?.type !== 'outputFrame') throw new Error('raw output missing')
    expect(Array.from(Buffer.from(frames[0].data, 'base64'))).toEqual(Array.from(bytes))
    expect(s.terminal.outputCount).toBe(3)
    expect(s.terminal.lastOutputAtMs).toBeGreaterThan(0)
    expect(s.terminal.activityDirty).toBe(true)
  })

  it('fans identical live bytes to binary and legacy clients without attach history', () => {
    const s = makeSession()
    const legacy = makeClient('legacy')
    const binary = makeClient('binary')
    const binaryFrames: Uint8Array[] = []
    const legacySibling = makeClient('legacy-sibling')
    const binarySibling = makeClient('binary-sibling')
    const binarySiblingFrames: Uint8Array[] = []
    binary.caps.add(CAP_TERMINAL_OUTPUT_BINARY_V1)
    binary.sendBinary = (frame) => binaryFrames.push(frame)
    binary.sendBinaryStream = (frame) => {
      binaryFrames.push(frame)
      return true
    }
    binarySibling.caps.add(CAP_TERMINAL_OUTPUT_BINARY_V1)
    binarySibling.sendBinary = (frame) => binarySiblingFrames.push(frame)
    binarySibling.sendBinaryStream = (frame) => {
      binarySiblingFrames.push(frame)
      return true
    }
    s.terminal.attachClient(legacy)
    s.terminal.attachClient(binary)
    s.terminal.attachClient(legacySibling)
    s.terminal.attachClient(binarySibling)

    const payload = Buffer.from([0x00, 0xff, 0xe2, 0x82])
    s.terminal.onFrame(payload.toString('base64'))

    const legacyFrame = legacy.sent.find((message) => message.type === 'outputFrame')
    expect(legacyFrame).toMatchObject({ seq: 0, epoch: 0 })
    if (legacyFrame?.type !== 'outputFrame') throw new Error('legacy output missing')
    expect(Buffer.from(legacyFrame.data, 'base64')).toEqual(payload)
    expect(legacySibling.sent.find((message) => message.type === 'outputFrame')).toBe(legacyFrame)
    expect(binarySiblingFrames[0]).toBe(binaryFrames[0])
    const live = decodeBinaryEnvelope(binaryFrames[0]!, PtyOutputBinaryMetadata)
    expect(live.metadata).toMatchObject({
      type: 'ptyOutput',
      sessionId: asSessionId('s1'),
      seq: 0,
      epoch: 0,
    })
    expect(Buffer.from(live.payload)).toEqual(payload)

    const replay = makeClient('binary-replay')
    const replayFrames: Uint8Array[] = []
    replay.caps.add(CAP_TERMINAL_OUTPUT_BINARY_V1)
    replay.sendBinary = (frame) => replayFrames.push(frame)
    s.terminal.attachClient(replay)
    expect(replayFrames).toEqual([])
    s.terminal.acceptOutput(payload, 1)
    const liveAfterAttach = decodeBinaryEnvelope(replayFrames[0]!, PtyOutputBinaryMetadata)
    expect(liveAfterAttach.metadata).toMatchObject({ seq: 1, epoch: 0 })
    expect(Buffer.from(liveAfterAttach.payload)).toEqual(payload)
  })

  it('tells the attaching client whether the PTY has ever produced output', () => {
    // POD-385: an empty screen means either "the child has printed nothing yet"
    // (a CLI still booting) or "we no longer hold its replay". Only the server
    // knows which, so the attach says it.
    const s = makeSession()
    const first = makeClient('a')
    s.terminal.attachClient(first)
    expect(first.sent.find((m) => m.type === 'attached')).toMatchObject({ outputSeen: false })
    s.terminal.onFrame('ZGF0YQ==')
    const second = makeClient('b')
    s.terminal.attachClient(second)
    expect(second.sent.find((m) => m.type === 'attached')).toMatchObject({ outputSeen: true })
  })

  it('reports output a restart inherited, without a cached picture', () => {
    // The durable counter distinguishes a revived session from one that has
    // never produced output, even without a picture.
    const s = makeSession(undefined, { outputCount: 12 })
    const a = makeClient('a')
    s.terminal.attachClient(a)
    expect(a.sent.find((m) => m.type === 'attached')).toMatchObject({ outputSeen: true })
    expect(a.sent.filter((m) => m.type === 'outputFrame')).toEqual([])
  })

  it('a later viewer keeps its screen and receives only bytes after attach', () => {
    const s = makeSession()
    s.terminal.onFrame('YQ==')
    s.terminal.onFrame('Yg==')
    const a = makeClient('a')
    s.terminal.attachClient(a)
    expect(a.sent.find((m) => m.type === 'attached')).toMatchObject({ resumed: true })
    expect(a.sent.filter((m) => m.type === 'outputFrame')).toEqual([])
    s.terminal.onFrame('Yw==')
    expect(a.sent.filter((m) => m.type === 'outputFrame')).toEqual([
      { type: 'outputFrame', sessionId: asSessionId('s1'), seq: 2, epoch: 0, data: 'Yw==' },
    ])
  })

  it('does not retain large output or empty frames for later viewers', () => {
    const s = makeSession()
    const payload = Buffer.alloc(140_000, 0x78)
    for (let i = 0; i < 3; i += 1) s.terminal.acceptOutput(payload, 1)
    for (let i = 0; i < 4097; i += 1) s.terminal.acceptOutput(new Uint8Array(), 1)
    expect(() => s.terminal.acceptOutput(new Uint8Array(), Number.MAX_SAFE_INTEGER)).toThrow()
    const a = makeClient('a')
    s.terminal.attachClient(a)
    expect(a.sent.filter((m) => m.type === 'outputFrame')).toEqual([])
    expect(s.terminal.outputCount).toBe(4100)
  })

  it('a fresh attach never automatically redraws an idle program', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    s.terminal.attachClient(makeClient('a'))
    s.terminal.onFrame('YQ==')
    s.terminal.attachClient(makeClient('b'))
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'redraw' }))
  })

  it('reassignController moves the role from a stale client to its reconnected self', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.terminal.attachClient(a)
    expect(s.terminal.controllerId).toBe('a')
    s.terminal.reassignController('a', 'a2')
    expect(s.terminal.controllerId).toBe('a2')
    // No-op when the named client isn't the controller.
    s.terminal.reassignController('ghost', 'x')
    expect(s.terminal.controllerId).toBe('a2')
  })

  it('reassigns controller when the controller detaches', () => {
    const s = makeSession()
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a)
    s.terminal.attachClient(b)
    a.viewports.set('s1', { cols: 100, rows: 30 })
    a.viewports.set('other-session', { cols: 40, rows: 12 })
    s.terminal.detachClient('a')
    expect(s.terminal.controllerId).toBe('b')
    expect(a.viewports.has('s1')).toBe(false)
    expect(a.viewports.has('other-session')).toBe(true)
    expect(b.sent).toContainEqual(
      expect.objectContaining({ type: 'controllerChanged', controllerId: 'b' }),
    )
  })

  it('atomically fits the sole measured native renderer when the controller detaches', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const desktop = makeClient('desktop')
    const phone = makeClient('phone')
    s.terminal.attachClient(desktop)
    s.terminal.attachClient(phone)
    phone.viewVisible = new Set([asSessionId('s1')])
    phone.viewModes = { s1: 'native' }
    phone.viewports.set('s1', { cols: 42, rows: 19 })
    toDaemon.mockClear()

    s.terminal.detachClient('desktop')

    expect(s.terminal.controllerId).toBe('phone')
    // Forwarded, with no redraw; the copy waits for the report.
    expect(toDaemon.mock.calls).toEqual([
      [
        {
          type: 'resize',
          sessionId: asSessionId('s1'),
          cols: 42,
          rows: 19,
        },
      ],
    ])
    expect(phone.sent).toContainEqual(
      expect.objectContaining({ type: 'controllerChanged', controllerId: 'phone', geometry: geo }),
    )
  })

  it('takeover uses the new controller viewport measured for this session', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    const b = makeClient('b')
    s.terminal.attachClient(a) // a is the initial controller
    s.terminal.attachClient(b)
    b.viewVisible = new Set([asSessionId('s1')]) // b renders the session → snap to its viewport on takeover
    b.viewports.set('s1', { cols: 33, rows: 21 })
    s.terminal.requestControl('b') // genuine takeover (b was NOT the controller)
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'resize',
      sessionId: asSessionId('s1'),
      cols: 33,
      rows: 21,
    })
  })

  it('never reconciles another session viewport into this session', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.terminal.attachClient(a)
    a.viewVisible = new Set([asSessionId('s1')])
    // Another split/warm pane measured a small grid, but s1 has not sent a
    // resize. The old single ClientConn.viewport applied this value to s1.
    a.viewports.set('other-session', { cols: 40, rows: 12 })

    s.terminal.reconcile()

    expect(s.terminal.geometry).toEqual(geo)
    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }))
  })

  it('marks exited and broadcasts agentExit', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.terminal.attachClient(a)
    s.onExit(0)
    expect(s.status).toBe('exited')
    expect(a.sent).toContainEqual({ type: 'agentExit', sessionId: asSessionId('s1'), code: 0 })
    expect(s.toMeta(NO_SESSION_USER_STATE)).toMatchObject({ status: 'exited', exitCode: 0 })
  })

  it('keeps the daemon spawn diagnosis in wire and durable state until retry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = makeSession()
    s.selectedDriverId = 'generic-pty'
    s.attachKinds = ['client']
    s.markSpawnError('codex executable was not found')
    expect(s.attachKinds).toBeUndefined()

    expect(s.toMeta(NO_SESSION_USER_STATE)).toMatchObject({
      status: 'exited',
      exitCode: -1,
      spawnFailure: 'codex executable was not found',
    })
    expect(s.toMeta(NO_SESSION_USER_STATE).driverFamily).toBeUndefined()
    expect(s.toRow()).toMatchObject({
      spawnFailure: 'codex executable was not found',
      selectedDriverId: null,
    })

    s.markResumed()
    expect(s.toMeta(NO_SESSION_USER_STATE).spawnFailure).toBeUndefined()
    expect(s.toRow().spawnFailure).toBeNull()
    warn.mockRestore()
  })

  it('markLive promotes a reconnecting session to live', () => {
    const s = new Session({
    ownerUserId: firstAdminMemberId(),
      sessionId: asSessionId('s1'),
      durableLabel: 'podium-s1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: '2026-06-03T00:00:00.000Z',
      geometry: geo,
      machineId: TEST_MACHINE,
      toDaemon: vi.fn(),
      status: 'reconnecting',
    })
    expect(s.toMeta(NO_SESSION_USER_STATE).status).toBe('reconnecting')
    s.markLive('claude', geo)
    expect(s.toMeta(NO_SESSION_USER_STATE).status).toBe('live')
  })

  it('THE BIND IS A FULL STATEMENT: the copy is the daemon’s size, and a box it lost is re-driven', () => {
    // POD-4771 (design rev 3, rule 2). The browser attached, took control and
    // stated 38x35 while the daemon was still forking. A daemon with no
    // terminal yet drops that ask (it holds no pending resize any more), so the
    // bind reports the 80x24 the pty was born at. The copy takes the daemon's
    // number — and because the bind resets what the server last asked for to
    // that number, the reconcile forwards the controller's box again.
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.terminal.attachClient(a) // controller
    a.viewVisible = new Set([asSessionId('s1')])
    s.terminal.handleResize('a', 38, 35)
    toDaemon.mockClear()
    a.sent.length = 0

    s.markLive('codex', geo) // the daemon binds at the 80x24 it spawned with

    expect(s.terminal.geometry).toEqual(geo)
    expect(toDaemon.mock.calls).toEqual([
      [{ type: 'resize', sessionId: asSessionId('s1'), cols: 38, rows: 35 }],
    ])
    // The copy did not move, so nothing is announced.
    expect(a.sent.filter((m) => m.type === 'geometry')).toEqual([])
  })

  it('markLive does not resize a PTY that already bound at our geometry', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon)
    const a = makeClient('a')
    s.terminal.attachClient(a)
    a.viewVisible = new Set([asSessionId('s1')])
    s.terminal.handleResize('a', 38, 35)
    toDaemon.mockClear()

    s.markLive('codex', { cols: 38, rows: 35 })

    expect(toDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }))
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
      geometry: geo,
      machineId: TEST_MACHINE,
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

  it('preserves a persisted compute total when a reloaded old daemon omits it', () => {
    const s = new Session({
    ownerUserId: firstAdminMemberId(),
      sessionId: asSessionId('s1'),
      durableLabel: 'podium-s1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      lastActiveAt: '2026-06-10T00:00:00.000Z',
      workingMsTotal: 42_000,
      geometry: geo,
      machineId: TEST_MACHINE,
      toDaemon: vi.fn(),
      status: 'reconnecting',
    })

    s.setAgentState(state('idle', '2026-06-10T00:01:00.000Z'))
    expect(s.agentState?.workingMsTotal).toBe(42_000)
    expect(s.toRow().workingMsTotal).toBe(42_000)

    s.setAgentState({
      ...state('working', '2026-06-10T00:02:00.000Z'),
      workingMsTotal: 50_000,
    })
    expect(s.agentState?.workingMsTotal).toBe(42_000)

    s.setAgentState({
      ...state('idle', '2026-06-10T00:03:00.000Z'),
      workingMsTotal: 55_000,
    })
    expect(s.agentState?.workingMsTotal).toBe(47_000)
    expect(s.toRow().workingMsTotal).toBe(47_000)
  })

  it('markLive (daemon reattach/bind) does NOT restamp lastActiveAt', () => {
    const s = new Session({
    ownerUserId: firstAdminMemberId(),
      sessionId: asSessionId('s1'),
      durableLabel: 'podium-s1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      lastActiveAt: '2026-06-10T00:00:00.000Z',
      geometry: geo,
      machineId: TEST_MACHINE,
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
    ownerUserId: firstAdminMemberId(),
      sessionId: asSessionId('sh'),
      durableLabel: 'podium-sh',
      agentKind: 'shell',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      geometry: geo,
      machineId: TEST_MACHINE,
      toDaemon: vi.fn(),
    })
    s.terminal.attachClient(makeClient('a'))
    s.terminal.handleInput('a', Buffer.from('ls\r').toString('base64'))
    expect(s.lastActiveAt > CREATED).toBe(true)
  })

  it('toMeta surfaces the VIEWER’s snoozedUntil, and absent ≠ null', () => {
    // POD-1076 deleted the `snoozedUntil` mirror field; the value arrives in the
    // overlay. The three-valued distinction is what matters and is asserted here
    // because collapsing it un-snoozes every open-ended snooze:
    //   undefined = no snooze row · null = until-next-message · ISO = timed.
    const s = makeSession()
    const snoozed = (until: string | null | undefined) =>
      s.toMeta({ readAt: null, snoozedUntil: until })

    expect('snoozedUntil' in snoozed(undefined)).toBe(false)
    expect(snoozed(null).snoozedUntil).toBeNull()
    expect('snoozedUntil' in snoozed(null)).toBe(true)
    expect(snoozed('2999-01-01T05:00:00.000Z').snoozedUntil).toBe('2999-01-01T05:00:00.000Z')
  })

  // Agent action offer [spec:SP-c7f1].
  it('toMeta surfaces offer only when set; clearOffer reports change', () => {
    const s = makeSession()
    expect('offer' in s.toMeta(NO_SESSION_USER_STATE)).toBe(false)
    expect(s.clearOffer()).toBe(false)

    const offer = {
      message: 'Tests are red on main',
      actions: [{ label: 'Fix them', prompt: 'Please fix the failing tests' }],
      createdAt: '2026-07-16T00:00:00.000Z',
    }
    s.offer = offer
    expect(s.toMeta(NO_SESSION_USER_STATE).offer).toEqual(offer)

    expect(s.clearOffer()).toBe(true)
    expect('offer' in s.toMeta(NO_SESSION_USER_STATE)).toBe(false)
  })

  it('toMeta surfaces draftUpdatedAt only when a draft exists', () => {
    const s = makeSession()
    expect('draftUpdatedAt' in s.toMeta(NO_SESSION_USER_STATE)).toBe(false)

    s.draftUpdatedAt = '2026-06-24T12:00:00.000Z'
    expect(s.toMeta(NO_SESSION_USER_STATE).draftUpdatedAt).toBe('2026-06-24T12:00:00.000Z')

    s.draftUpdatedAt = undefined
    expect('draftUpdatedAt' in s.toMeta(NO_SESSION_USER_STATE)).toBe(false)
  })
})

describe('Session transcript cache (recent-delta window)', () => {
  const item = (id: string, cursor: string, text = id) =>
    ({ id, role: 'user' as const, text, cursor }) as const

  it('applyDelta appends, fans out a transcriptDelta, and flips availability once', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.terminal.subscribeTranscript(a)
    // Empty subscribe → no replay frame.
    expect(a.sent.filter((m) => m.type === 'transcriptDelta')).toEqual([])

    const became = s.terminal.applyDelta([item('u1', 'c1')], { tail: 'c1' })
    expect(became).toBe(true) // first transcript observed → chat capability flips on
    expect(a.sent.at(-1)).toEqual({
      type: 'transcriptDelta',
      sessionId: asSessionId('s1'),
      items: [item('u1', 'c1')],
      tail: 'c1',
    })
    expect(s.terminal.transcriptItems()).toEqual([item('u1', 'c1')])
    // A second delta no longer flips availability.
    expect(s.terminal.applyDelta([item('u2', 'c2')], {})).toBe(false)
    expect(s.terminal.transcriptItems()).toEqual([item('u1', 'c1'), item('u2', 'c2')])
  })

  it('delivers Grok daemon items live and replays stable ids once to a reload subscriber', () => {
    const s = makeSession()
    const live = makeClient('grok-live')
    s.terminal.subscribeTranscript(live)
    const items = [
      item('grok-user-token', 'grok-user-cursor', 'user token'),
      item('grok-assistant-token', 'grok-assistant-cursor', 'assistant token'),
    ]

    s.terminal.applyDelta(items, { reset: true, tail: 'grok-assistant-cursor' })
    s.terminal.applyDelta(items, { reset: true, tail: 'grok-assistant-cursor' })
    expect(s.terminal.transcriptItems()).toEqual(items)
    expect(live.sent.filter((message) => message.type === 'transcriptDelta')).toHaveLength(2)

    const reload = makeClient('grok-reload')
    s.terminal.subscribeTranscript(reload)
    expect(reload.sent).toEqual([
      { type: 'transcriptDelta', sessionId: asSessionId('s1'), items },
    ])
  })

  it('replaces a re-emitted cursor in the cache instead of recording it twice', () => {
    const s = makeSession()
    const partial = item('provider-v1', 'stable-cursor', 'Hel')
    const complete = item('provider-v2', 'stable-cursor', 'Hello')

    s.terminal.applyDelta([partial], {})
    s.terminal.applyDelta([complete], {})

    expect(s.terminal.transcriptItems()).toEqual([complete])
    const late = makeClient('late')
    s.terminal.subscribeTranscript(late)
    expect(late.sent).toEqual([
      {
        type: 'transcriptDelta',
        sessionId: asSessionId('s1'),
        items: [complete],
      },
    ])
  })

  it('applyDelta({reset}) clears the cache and fans out reset:true', () => {
    const s = makeSession()
    const a = makeClient('a')
    s.terminal.subscribeTranscript(a)
    s.terminal.applyDelta([item('u1', 'c1')], {})
    s.terminal.applyDelta([item('u2', 'c2')], { reset: true, tail: 'c2' })
    expect(s.terminal.transcriptItems()).toEqual([item('u2', 'c2')])
    expect(a.sent.at(-1)).toEqual({
      type: 'transcriptDelta',
      sessionId: asSessionId('s1'),
      items: [item('u2', 'c2')],
      tail: 'c2',
      reset: true,
    })
  })

  it('subscribeTranscript(since) replays only items after since; whole cache when unknown; nothing when caught up', () => {
    const s = makeSession()
    s.terminal.applyDelta([item('a', 'c1'), item('b', 'c2'), item('c', 'c3')], { tail: 'c3' })

    const known = makeClient('k')
    s.terminal.subscribeTranscript(known, 'c1')
    expect(known.sent).toEqual([
      {
        type: 'transcriptDelta',
        sessionId: asSessionId('s1'),
        items: [item('b', 'c2'), item('c', 'c3')],
      },
    ])

    const stale = makeClient('s')
    s.terminal.subscribeTranscript(stale, 'older')
    expect(stale.sent).toEqual([
      {
        type: 'transcriptDelta',
        sessionId: asSessionId('s1'),
        items: [item('a', 'c1'), item('b', 'c2'), item('c', 'c3')],
      },
    ])

    const caught = makeClient('c')
    s.terminal.subscribeTranscript(caught, 'c3')
    expect(caught.sent).toEqual([])
  })

  it('handleInput from the controller bumps lastInputAt and marks dirty', () => {
    const s = makeSession()
    // First attach makes this client the controller (see attachClient).
    s.terminal.attachClient(makeClient('c'))
    expect(s.terminal.lastInputAtMs).toBe(0)
    s.terminal.handleInput('c', Buffer.from('x').toString('base64'))
    expect(s.terminal.lastInputAtMs).toBeGreaterThan(0)
    expect(s.terminal.activityDirty).toBe(true)
  })

  it('markResumed bumps lastResumedAt and marks dirty without touching lastActiveAt', () => {
    const s = new Session({
    ownerUserId: firstAdminMemberId(),
      sessionId: asSessionId('s1'),
      durableLabel: 'podium-s1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      geometry: geo,
      machineId: TEST_MACHINE,
      toDaemon: vi.fn(),
      lastActiveAt: '2026-06-01T00:00:00.000Z',
    })
    s.markResumed()
    expect(s.terminal.lastResumedAtMs).toBeGreaterThan(0)
    expect(s.terminal.activityDirty).toBe(true)
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
    ownerUserId: firstAdminMemberId(),
      sessionId: asSessionId('s1'),
      durableLabel: 'podium-s1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      geometry: geo,
      machineId: TEST_MACHINE,
      toDaemon: vi.fn(),
      lastInputAt: '2026-06-29T02:00:00.000Z',
    })
    expect(s.terminal.lastInputAtMs).toBe(Date.parse('2026-06-29T02:00:00.000Z'))
    expect(s.terminal.clearActivityDirty).toBeTypeOf('function')
    s.terminal.clearActivityDirty()
    expect(s.terminal.activityDirty).toBe(false)
  })

  it('seeds a malformed activity ISO as 0 (never NaN — would freeze hibernation)', () => {
    const s = new Session({
    ownerUserId: firstAdminMemberId(),
      sessionId: asSessionId('s1'),
      durableLabel: 'podium-s1',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: CREATED,
      geometry: geo,
      machineId: TEST_MACHINE,
      toDaemon: vi.fn(),
      lastOutputAt: 'not-a-date',
      lastInputAt: 'garbage',
      lastResumedAt: '',
    })
    // A NaN seed would make Math.max(..., NaN) === NaN and keep the session
    // awake forever; the guard must fall back to 0 instead.
    expect(s.terminal.lastOutputAtMs).toBe(0)
    expect(s.terminal.lastInputAtMs).toBe(0)
    expect(s.terminal.lastResumedAtMs).toBe(0)
    // 0 serializes back to null, so a bad value doesn't poison the persisted row.
    expect(s.toRow().lastOutputAt).toBeNull()
    expect(s.toRow().lastInputAt).toBeNull()
    expect(s.toRow().lastResumedAt).toBeNull()
  })
})

describe('driver family on the wire (POD-2290)', () => {
  /**
   * The web panel picks chat-vs-native from this field. Before it existed, an
   * opencode/codex/grok session — which has no PTY at all — opened on the native
   * pane and sat behind a "Starting <Harness>…" spinner that could never resolve,
   * because the client had only the driver ID and no way to know what it meant.
   */
  it('projects the family of the driver the daemon actually bound', () => {
    const s = makeSession()
    s.driverId = 'opencode-server'
    expect(s.toMeta(NO_SESSION_USER_STATE).driverFamily).toBe('server')
    s.attachKinds = ['client']
    expect(s.toMeta(NO_SESSION_USER_STATE).attachKinds).toEqual(['client'])

    s.driverId = 'claude-pty'
    expect(s.toMeta(NO_SESSION_USER_STATE).driverFamily).toBe('terminal')
  })

  it('reads the BOUND driver, not the one that was asked for', () => {
    // A degraded selection is exactly the case a `requestedDriverId`-derived
    // family would get backwards: this session asked for a server and got a
    // terminal, and it has the terminal.
    const s = makeSession()
    s.driverId = 'generic-pty'
    s.requestedDriverId = 'grok-acp'
    expect(s.toMeta(NO_SESSION_USER_STATE).driverFamily).toBe('terminal')
  })

  it('answers from the SELECTED driver before any bind has happened', () => {
    /**
     * The measurement that reopened this issue (POD-2290 round two): on the
     * drive instance an `opencode` session sat `starting` with no `driverId`
     * for TWELVE SECONDS while `opencode serve` booted, and the web panel had
     * to choose a view in that window. The daemon knew the answer the whole
     * time; it now says so before it launches anything, and this is where that
     * lands.
     */
    const s = makeSession()
    s.selectedDriverId = 'opencode-server'
    expect(s.toMeta(NO_SESSION_USER_STATE).driverFamily).toBe('server')
    // …and the bind that follows is still what wins, because a launch that
    // failed and fell back must not be described by the plan it abandoned.
    s.driverId = 'generic-pty'
    expect(s.toMeta(NO_SESSION_USER_STATE).driverFamily).toBe('terminal')
  })

  it('is ABSENT rather than guessed when there is nothing to derive it from', () => {
    // `driverId` is transient — an older daemon, a legacy session, and a row
    // that has not bound yet all have none. Absent means unknown, and every
    // client reads unknown as "assume a terminal", which is what keeps a PTY
    // session behaving exactly as it did before this field existed.
    const s = makeSession()
    expect(s.toMeta(NO_SESSION_USER_STATE).driverFamily).toBeUndefined()
    // …and an id from a newer build that no manifest here claims is unknown too,
    // rather than being forced into whichever family this build defaults to.
    s.driverId = 'some-driver-from-2027'
    expect(s.toMeta(NO_SESSION_USER_STATE).driverFamily).toBeUndefined()
  })
})

describe('OOM truth on the row (POD-2413)', () => {
  it('names an exit that followed a kernel kill "oom" instead of "exited"', () => {
    const session = makeSession()
    session.recordOomKill(new Date().toISOString())
    session.onExit(137)
    expect(session.status).toBe('exited')
    expect(session.stopReason).toBe('oom')
  })

  it('upgrades a stamped exit when the kill report lands after it', () => {
    // The daemon samples cgroups on a timer, so the evidence routinely arrives
    // AFTER the exit frame. A row that stayed "exited" because the observer was
    // a few seconds late would hide the one death an operator can act on.
    const session = makeSession()
    session.onExit(137)
    expect(session.stopReason).toBe('exited')
    session.recordOomKill(new Date().toISOString())
    expect(session.stopReason).toBe('oom')
  })

  it('leaves an unrelated later exit alone', () => {
    // `OOMPolicy=continue` means a killed build does not end the session. If it
    // keeps working and exits cleanly an hour later, that exit is not an OOM.
    const session = makeSession()
    session.recordOomKill(new Date(Date.now() - 60 * 60 * 1000).toISOString())
    session.onExit(0)
    expect(session.stopReason).toBe('exited')
  })

  it('does not overwrite the richer reason an explicit stop already stamped', () => {
    const session = makeSession()
    session.stoppedAt = new Date().toISOString()
    session.stopReason = 'forced'
    session.recordOomKill(new Date().toISOString())
    session.onExit(137)
    expect(session.stopReason).toBe('forced')
  })

  it('never resurrects a hibernated row into an OOM death', () => {
    // A hibernate kill IS a SIGKILL, and its cgroup may well carry an earlier
    // kill. `onExit` returns early for a hibernated row; this pins that the OOM
    // path did not become a way around it.
    const session = makeSession()
    session.status = 'hibernated'
    session.recordOomKill(new Date().toISOString())
    session.onExit(137)
    expect(session.status).toBe('hibernated')
    expect(session.stopReason).toBeUndefined()
  })
})


/**
 * THE PREVIEW PLANE ON THE TERMINAL (POD-2293).
 *
 * The terminal owns the transcript-subscriber set, so it owns the two things
 * that follow from it: telling the daemon what level this session's viewers
 * need, and catching a late subscriber up on the turn already in progress.
 */
describe('Session turn preview', () => {
  const frame = (turnEpoch: number, text: string, done?: boolean) =>
    ({
      type: 'turnPreview' as const,
      sessionId: asSessionId('s1'),
      turnEpoch,
      seq: 1,
      items: [{ kind: 'text' as const, itemId: 'a', text }],
      ...(done ? { done: true } : {}),
    })

  it('asks for fine on the FIRST subscriber and coarse on the last unsubscribe', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon, { turnPreviewEnabled: true })
    const a = makeClient('a')
    const b = makeClient('b')

    s.terminal.subscribeTranscript(a)
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'runtimeWatch',
      sessionId: asSessionId('s1'),
      level: 'fine',
    })
    // A SECOND viewer is not a second request. The frame carries a desired
    // state, and re-sending it per subscriber would be noise the daemon has to
    // dedupe on the other side.
    toDaemon.mockClear()
    s.terminal.subscribeTranscript(b)
    expect(toDaemon).not.toHaveBeenCalled()

    // Nor is losing ONE of two viewers a reason to stop streaming.
    s.terminal.unsubscribeTranscript('a')
    expect(toDaemon).not.toHaveBeenCalled()

    s.terminal.unsubscribeTranscript('b')
    expect(toDaemon).toHaveBeenCalledWith({
      type: 'runtimeWatch',
      sessionId: asSessionId('s1'),
      level: 'coarse',
    })
  })

  /**
   * THE OTHER DIRECTION, AND IT IS THE ONE THE PLANE'S CONTAINMENT CLAIM RESTED
   * ON (POD-2745). "Fine is only taken for a session someone is watching" cannot
   * be shown by any number of subscribe-then-assert-fine tests: they would all
   * pass just as well if the level were always on. What shows it is a session
   * with a full client lifecycle and NO chat ever opened, producing no runtime
   * traffic whatsoever.
   *
   * This failed before the fix, and not in a way anyone would have looked for:
   * the very first reconcile compared `coarse` against an UNSET field, called
   * that a crossing, and told the daemon to be what it already was. A plain
   * detach on an ordinary PTY session was enough to fire it.
   */
  it('says nothing about a session nobody ever opened a chat on', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon, { turnPreviewEnabled: true })
    const desktop = makeClient('desktop')
    const phone = makeClient('phone')
    s.terminal.attachClient(desktop)
    s.terminal.attachClient(phone)
    s.terminal.detachClient('desktop')
    s.terminal.detachAll()
    expect(toDaemon.mock.calls.filter(([m]) => m.type === 'runtimeWatch')).toEqual([])
  })

  /**
   * A BIND IS A NEW DAEMON, AND A NEW DAEMON HOLDS NO WATCHES.
   *
   * `watchLevelSent` is a claim about another process's state. When that process
   * restarts the claim is stale in the one direction that fails silently: it
   * still reads `fine`, so every later reconcile agrees with itself and no frame
   * is ever sent again. The viewer keeps their chat open and the fragments just
   * stop.
   */
  it('re-asks for fine when a daemon rebinds under a viewer who never left', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon, { turnPreviewEnabled: true })
    s.terminal.subscribeTranscript(makeClient('a'))
    toDaemon.mockClear()

    s.terminal.resetWatchLevel()

    expect(toDaemon.mock.calls.filter(([m]) => m.type === 'runtimeWatch')).toEqual([
      [{ type: 'runtimeWatch', sessionId: asSessionId('s1'), level: 'fine' }],
    ])
  })

  it('re-asks for nothing when a daemon rebinds with no viewer', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon, { turnPreviewEnabled: true })
    s.terminal.attachClient(makeClient('a'))
    toDaemon.mockClear()

    s.terminal.resetWatchLevel()

    expect(toDaemon.mock.calls.filter(([m]) => m.type === 'runtimeWatch')).toEqual([])
  })

  it('asks for nothing at all while the switch is off', () => {
    const toDaemon = vi.fn()
    const s = makeSession(toDaemon, { turnPreviewEnabled: false })
    s.terminal.subscribeTranscript(makeClient('a'))
    expect(toDaemon.mock.calls.filter(([m]) => m.type === 'runtimeWatch')).toEqual([])
  })

  it('fans a frame out to subscribers and catches the next one up on it', () => {
    const s = makeSession(vi.fn(), { turnPreviewEnabled: true })
    const a = makeClient('a')
    s.terminal.subscribeTranscript(a)
    s.terminal.applyTurnPreview(frame(1, 'half a rep'))
    expect(a.sent.at(-1)).toEqual(frame(1, 'half a rep'))

    const late = makeClient('late')
    s.terminal.subscribeTranscript(late)
    expect(late.sent.at(-1)).toEqual(frame(1, 'half a rep'))
  })

  it('replays the preview AFTER the durable items it follows', () => {
    const s = makeSession(vi.fn(), { turnPreviewEnabled: true })
    s.terminal.applyDelta(
      [{ id: 'u1', role: 'user' as const, text: 'hi', cursor: 'c1' }],
      { tail: 'c1' },
    )
    s.terminal.applyTurnPreview(frame(1, 'repl'))
    const late = makeClient('late')
    s.terminal.subscribeTranscript(late)
    // Order matters: the preview is the part of the turn the transcript does
    // not have yet, so a client receiving it first would briefly render the
    // in-progress rows above the items they follow.
    expect(late.sent.map((m) => m.type)).toEqual(['transcriptDelta', 'turnPreview'])
  })

  it('stops retaining a preview once the turn is done', () => {
    const s = makeSession(vi.fn(), { turnPreviewEnabled: true })
    const a = makeClient('a')
    s.terminal.subscribeTranscript(a)
    s.terminal.applyTurnPreview(frame(1, 'half'))
    s.terminal.applyTurnPreview({ ...frame(1, ''), items: [], done: true })
    // The terminal frame still reaches the open viewer — it is what clears the
    // rows — but nothing is kept for the next one.
    expect(a.sent.at(-1)).toMatchObject({ type: 'turnPreview', done: true })
    const late = makeClient('late')
    s.terminal.subscribeTranscript(late)
    expect(late.sent.filter((m) => m.type === 'turnPreview')).toEqual([])
  })

  it('drops the retained preview when every viewer detaches', () => {
    const s = makeSession(vi.fn(), { turnPreviewEnabled: true })
    s.terminal.subscribeTranscript(makeClient('a'))
    s.terminal.applyTurnPreview(frame(1, 'half'))
    s.terminal.detachAll()
    const late = makeClient('late')
    s.terminal.subscribeTranscript(late)
    // A preview replayed after a gap describes a turn that has very likely
    // ended, and shows a session that looks like it is still typing.
    expect(late.sent.filter((m) => m.type === 'turnPreview')).toEqual([])
  })
})


describe('persisted lifecycle driver intent', () => {
  it.each([
    { selected: undefined, requested: undefined, expected: undefined },
    { selected: 'generic-pty', requested: undefined, expected: undefined },
    { selected: 'codex-pty', requested: undefined, expected: undefined },
    { selected: 'codex-app-server', requested: undefined, expected: 'codex-app-server' },
    { selected: 'claude-sdk', requested: undefined, expected: 'claude-sdk' },
    { selected: 'headless', requested: undefined, expected: 'headless' },
    { selected: 'generic-pty', requested: 'claude-pty', expected: 'claude-pty', reattach: 'generic-pty' },
    { selected: 'generic-pty', requested: 'codex-app-server', expected: 'codex-app-server', reattach: 'generic-pty' },
    { selected: 'codex-app-server', requested: 'opencode-server', expected: 'opencode-server', reattach: 'codex-app-server' },
    { selected: 'headless', requested: 'opencode-server', expected: 'opencode-server', reattach: 'headless' },
  ])('preserves old-row and explicit intent: $selected / $requested', ({ selected, requested, expected, ...recovery }) => {
    const s = makeSession()
    s.selectedDriverId = selected
    s.requestedDriverId = requested
    expect(s.lifecycleDriverRequest()).toBe(expected)
    expect(s.reattachDriverRequest()).toBe('reattach' in recovery ? recovery.reattach : expected)
    // Reattach recovers the selected engine; wake honors requested intent. Omission remains headed;
    // mandatory daemon admission must not reinterpret it as manifest policy.
    expect(s.toRow()).toMatchObject({
      selectedDriverId: selected ?? null, requestedDriverId: requested ?? null,
    })
  })
})
