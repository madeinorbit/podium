/**
 * SIZING PLAN ASSUMPTION TESTS — server half (POD-3235, spec artifact SPEC-0b.md rev 2).
 *
 * Every factual claim the terminal-sizing plan (POD-3190) makes about TODAY's
 * server code, executed rather than read. Three reviews of that plan changed no
 * model rule and still found ~20 errors in its DESCRIPTION of this code, all of
 * them from reading — so each claim gets a test that runs against the real
 * classes, and stage 1 (POD-3239) deletes the machinery only with these green.
 *
 * These are CHARACTERIZATION tests: they pin what the code does now, including
 * the parts stage 1 intends to change. When stage 1 changes a behaviour it
 * rewrites the matching claim in the same commit — see SPEC-1.md's acceptance.
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  FIRST_ADMIN_USER_ID,
  type Geometry,
  type SessionId,
  SessionMeta,
} from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { userClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionRegistry } from '../../relay'
import { SessionClientControl } from './client-control'
import { SessionInbox } from './inbox'
import type { Session } from './session'
import { Session as SessionClass } from './session'
import { DEFAULT_GEOMETRY } from './session-shared'
import { SessionTerminal } from './terminal'

const SESSION = asSessionId('s-sizing')
const MACHINE = asMachineId('m-sizing')
const OWNER = asUserId(FIRST_ADMIN_USER_ID)
const GEO: Geometry = { cols: 80, rows: 24 }

type Sent = ClientConn & { sent: ServerMessage[]; principal: ClientPrincipal }

function makeClient(id: string): Sent {
  const sent: ServerMessage[] = []
  return {
    id,
    principal: userClientPrincipal(id, OWNER, 'admin'),
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

/** The real SessionTerminal over a recording daemon channel. */
function makeTerminal(geometry: Geometry = GEO): {
  terminal: SessionTerminal
  toDaemon: ControlMessage[]
} {
  const toDaemon: ControlMessage[] = []
  const terminal = new SessionTerminal({
    sessionId: SESSION,
    agentKind: 'claude-code',
    geometry: { ...geometry },
    toDaemon: (m) => toDaemon.push(m),
  })
  return { terminal, toDaemon }
}

/** A client that is attached, has this session visible in native mode, and is controller. */
function controllerOf(terminal: SessionTerminal, id = 'c1'): Sent {
  const client = makeClient(id)
  client.viewVisible.add(SESSION)
  client.viewModes = { [SESSION]: 'native' }
  terminal.attachClient(client)
  expect(terminal.controllerId).toBe(client.id)
  return client
}

const geometryFrames = (client: Sent) =>
  client.sent.filter(
    (m): m is Extract<ServerMessage, { type: 'geometry' }> => m.type === 'geometry',
  )
const resizesTo = (toDaemon: ControlMessage[]) =>
  toDaemon
    .filter((m): m is Extract<ControlMessage, { type: 'resize' }> => m.type === 'resize')
    .map((m) => ({ cols: m.cols, rows: m.rows }))
const redraws = (toDaemon: ControlMessage[]) => toDaemon.filter((m) => m.type === 'redraw')

/** The registry exposes its live Session map only internally; the sizing claims
 *  need the real object, not the published row. */
interface InternalRegistry {
  modules: { sessions: { sessions: Map<string, Session> } }
}

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function registryFor(): { reg: SessionRegistry; daemon: ControlMessage[] } {
  const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
  return { reg, daemon }
}
const spawns = (daemon: ControlMessage[]) =>
  daemon.filter((m): m is Extract<ControlMessage, { type: 'spawn' }> => m.type === 'spawn')

// ---------------------------------------------------------------------------
// C3 (server half)
// ---------------------------------------------------------------------------

describe('C3: attachClient requests a redraw on every non-resumed replay and on an empty log', () => {
  it('fresh attach (no sinceSeq) redraws; the attached frame carries the current geometry', () => {
    const { terminal, toDaemon } = makeTerminal({ cols: 120, rows: 40 })
    const client = makeClient('c-fresh')
    terminal.attachClient(client)

    const attached = client.sent.find((m) => m.type === 'attached')
    expect(attached).toMatchObject({ geometry: { cols: 120, rows: 40 }, resumed: false })
    // Empty log AND not resumed → redraw, and `replayRequired` because the log is empty.
    expect(redraws(toDaemon)).toEqual([
      { type: 'redraw', sessionId: SESSION, replayRequired: true },
    ])
  })

  it('a RESUMED attach with a non-empty log does NOT redraw', () => {
    const { terminal, toDaemon } = makeTerminal()
    terminal.onFrame(Buffer.from('hello').toString('base64'))
    toDaemon.length = 0

    const client = makeClient('c-resume')
    terminal.attachClient(client, 0) // sinceSeq within the window → resumed
    expect(client.sent.find((m) => m.type === 'attached')).toMatchObject({ resumed: true })
    expect(redraws(toDaemon)).toEqual([])
  })

  it('a resumed attach against an EMPTY log still redraws (replayRequired)', () => {
    const { terminal, toDaemon } = makeTerminal()
    const client = makeClient('c-resume-empty')
    terminal.attachClient(client, 5) // no frames at all → resumed, but nothing to rebuild from
    expect(client.sent.find((m) => m.type === 'attached')).toMatchObject({ resumed: true })
    expect(redraws(toDaemon)).toEqual([
      { type: 'redraw', sessionId: SESSION, replayRequired: true },
    ])
  })
})

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

describe('C4: handleResize drops silently when the client is not controller or the session is not viewVisible', () => {
  it('a non-controller resize records the viewport and then drops: no daemon resize, no broadcast, no outcome', () => {
    const { terminal, toDaemon } = makeTerminal()
    const controller = controllerOf(terminal, 'c-controller')
    const spectator = makeClient('c-spectator')
    spectator.viewVisible.add(SESSION)
    terminal.attachClient(spectator)
    toDaemon.length = 0
    controller.sent.length = 0
    spectator.sent.length = 0

    terminal.handleResize(spectator.id, 200, 60)

    // The DROP is not total — the viewport IS recorded before the gate returns.
    expect(spectator.viewports.get(SESSION)).toEqual({ cols: 200, rows: 60 })
    expect(terminal.geometry).toEqual(GEO)
    expect(terminal.geometryRevision).toBe(0)
    expect(resizesTo(toDaemon)).toEqual([])
    expect(geometryFrames(controller)).toEqual([])
    expect(geometryFrames(spectator)).toEqual([])
    // Nothing tells the client its request went nowhere.
    expect(spectator.sent).toEqual([])

    // ARMING CHECK — the controller's resize on the same fixture DOES reach the
    // daemon and DOES broadcast to the spectator.
    controller.viewVisible.add(SESSION)
    terminal.handleResize(controller.id, 100, 32)
    expect(resizesTo(toDaemon)).toEqual([{ cols: 100, rows: 32 }])
    expect(geometryFrames(spectator).length).toBe(1)
  })

  it('the CONTROLLER is dropped just as silently when the session is not in its viewVisible', () => {
    const { terminal, toDaemon } = makeTerminal()
    const client = makeClient('c-hidden')
    terminal.attachClient(client) // controller by first-attach, but nothing visible
    expect(terminal.controllerId).toBe(client.id)
    toDaemon.length = 0
    client.sent.length = 0

    terminal.handleResize(client.id, 200, 60)

    expect(client.viewports.get(SESSION)).toEqual({ cols: 200, rows: 60 })
    expect(terminal.geometry).toEqual(GEO)
    expect(resizesTo(toDaemon)).toEqual([])
    expect(client.sent).toEqual([])
  })

  it('an UNATTACHED client id is dropped and records nothing at all', () => {
    const { terminal, toDaemon } = makeTerminal()
    terminal.handleResize('c-nobody', 200, 60)
    expect(terminal.geometry).toEqual(GEO)
    expect(resizesTo(toDaemon)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C5
// ---------------------------------------------------------------------------

describe('C5: viewState deletes the viewport when a session leaves visible-and-native; reconcileActiveRenderer then refuses to promote', () => {
  function makeSession(): Session {
    return new SessionClass({
      sessionId: SESSION,
      durableLabel: 'podium-s-sizing',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: '2026-06-03T00:00:00.000Z',
      geometry: GEO,
      machineId: MACHINE,
      ownerUserId: OWNER,
      toDaemon: vi.fn(),
    })
  }

  /**
   * The REAL SessionInbox — `reconcileActiveRenderer` reads only `getSession`
   * and `authorizeDrive`, and the refusal under test is its own `viewports.has`
   * guard, which a hand-written mirror in a fixture would silently drop.
   */
  function realInbox(session: Session): SessionInbox {
    return new SessionInbox({
      getSession: (id: SessionId) => (id === SESSION ? session : undefined),
      authorizeDrive: () => true,
    } as never)
  }

  function control(session: Session, inbox: SessionInbox): SessionClientControl {
    return new SessionClientControl({
      sessions: new Map([[SESSION, session]]),
      state: { replayDrafts: vi.fn(), handleDraftEdit: vi.fn() } as never,
      inbox,
      machinesForPrincipal: () => [],
      browserOpen: { submitCallback: vi.fn(), dismiss: vi.fn() } as never,
      mutate: (_id: SessionId, change: (s: Session) => void) => change(session),
      broadcastSessions: vi.fn(),
      pushPriorities: vi.fn(),
      setDraft: vi.fn(),
      editDraft: vi.fn(),
      sessionOwner: () => ({ owner: OWNER, grants: [] }),
      machineUseFor: () => 'granted' as const,
    } as never)
  }

  it('leaving VISIBLE deletes the viewport', () => {
    const session = makeSession()
    const ctl = control(session, realInbox(session))
    const client = makeClient('c-view')
    ctl.onFrame(client.principal, client, { type: 'attach', sessionId: SESSION })
    ctl.onFrame(client.principal, client, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'native' },
    })
    client.viewports.set(SESSION, { cols: 150, rows: 50 })

    ctl.onFrame(client.principal, client, { type: 'viewState', visible: [], focused: null })
    expect(client.viewports.has(SESSION)).toBe(false)
  })

  it('staying visible but switching OFF native (chat) also deletes the viewport', () => {
    const session = makeSession()
    const ctl = control(session, realInbox(session))
    const client = makeClient('c-chat')
    ctl.onFrame(client.principal, client, { type: 'attach', sessionId: SESSION })
    ctl.onFrame(client.principal, client, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'native' },
    })
    client.viewports.set(SESSION, { cols: 150, rows: 50 })

    ctl.onFrame(client.principal, client, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'chat' },
    })
    expect(client.viewports.has(SESSION)).toBe(false)
  })

  it('reconcileActiveRenderer refuses to promote a sole renderer whose viewport was just deleted', () => {
    const session = makeSession()
    const inbox = realInbox(session)
    const ctl = control(session, inbox)

    // Two natives: the desktop holds control, the phone renders too.
    const desktop = makeClient('c-desktop')
    const phone = makeClient('c-phone')
    for (const c of [desktop, phone]) {
      ctl.onFrame(c.principal, c, { type: 'attach', sessionId: SESSION })
      ctl.onFrame(c.principal, c, {
        type: 'viewState',
        visible: [SESSION],
        focused: SESSION,
        modes: { [SESSION]: 'native' },
      })
    }
    expect(session.terminal.controllerId).toBe('c-desktop')

    // The phone HAS a viewport, so it would be promotable...
    phone.viewports.set(SESSION, { cols: 62, rows: 36 })
    // ...but its own viewState (going to chat, then back to native) deletes it.
    ctl.onFrame(phone.principal, phone, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'chat' },
    })
    expect(phone.viewports.has(SESSION)).toBe(false)
    ctl.onFrame(phone.principal, phone, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'native' },
    })

    // The desktop leaves native. The phone is now the SOLE native renderer —
    // and is refused, because it has no recorded viewport.
    ctl.onFrame(desktop.principal, desktop, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'chat' },
    })
    expect(session.terminal.activeNativeRenderers().map((c) => c.id)).toEqual(['c-phone'])
    expect(inbox.reconcileActiveRenderer(SESSION)).toBe(false)
    expect(session.terminal.controllerId).toBe('c-desktop')

    // With a viewport it promotes — proving the refusal above is the viewport
    // guard and not some other precondition.
    phone.viewports.set(SESSION, { cols: 62, rows: 36 })
    expect(inbox.reconcileActiveRenderer(SESSION)).toBe(true)
    expect(session.terminal.controllerId).toBe('c-phone')
  })
})

// ---------------------------------------------------------------------------
// C6
// ---------------------------------------------------------------------------

describe('C6: adoptGeometryIfUncontrolled mutates and bumps the revision only when uncontrolled AND different, and broadcasts nothing', () => {
  /** Two attached clients and NO controller — `revokeController` is the only
   *  transition that reaches that state without emptying the client set, which
   *  matters: a fixture with nobody attached could not tell "broadcasts nothing"
   *  from "there was nobody to broadcast to". */
  function uncontrolledWithWatchers(): {
    terminal: SessionTerminal
    toDaemon: ControlMessage[]
    watchers: Sent[]
  } {
    const { terminal, toDaemon } = makeTerminal()
    const a = controllerOf(terminal, 'c-a')
    const b = makeClient('c-b')
    b.viewVisible.add(SESSION)
    b.viewModes = { [SESSION]: 'native' }
    terminal.attachClient(b)
    terminal.revokeController()
    expect(terminal.controllerId).toBeNull()
    expect(terminal.clientCount).toBe(2)
    a.sent.length = 0
    b.sent.length = 0
    toDaemon.length = 0
    return { terminal, toDaemon, watchers: [a, b] }
  }

  it('uncontrolled + different: geometry moves, revision bumps, NOTHING is broadcast or sent down', () => {
    const { terminal, toDaemon, watchers } = uncontrolledWithWatchers()
    const before = terminal.geometryRevision

    terminal.adoptGeometryIfUncontrolled({ cols: 120, rows: 40 })

    expect(terminal.geometry).toEqual({ cols: 120, rows: 40 })
    expect(terminal.geometryRevision).toBe(before + 1)
    for (const w of watchers) expect(geometryFrames(w)).toEqual([])
    expect(resizesTo(toDaemon)).toEqual([])

    // ARMING CHECK — the same two clients DO receive a geometry frame when
    // something broadcasts one, so the empty assertions above are the silence
    // of adoptGeometryIfUncontrolled and not a deaf fixture.
    terminal.requestControl(watchers[0]!.id, { cols: 90, rows: 30 })
    terminal.handleResize(watchers[0]!.id, 100, 32)
    for (const w of watchers) expect(geometryFrames(w).length).toBeGreaterThan(0)
  })

  it('uncontrolled + EQUAL geometry: nothing changes and the revision does not move', () => {
    const { terminal, watchers } = uncontrolledWithWatchers()
    const before = terminal.geometryRevision
    terminal.adoptGeometryIfUncontrolled({ ...GEO })
    expect(terminal.geometry).toEqual(GEO)
    expect(terminal.geometryRevision).toBe(before)
    for (const w of watchers) expect(geometryFrames(w)).toEqual([])
  })

  it('WITH a controller it declines, however different the reported geometry is', () => {
    const { terminal } = makeTerminal()
    controllerOf(terminal, 'c-owner')
    const before = terminal.geometryRevision
    terminal.adoptGeometryIfUncontrolled({ cols: 200, rows: 60 })
    expect(terminal.geometry).toEqual(GEO)
    expect(terminal.geometryRevision).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// C13
// ---------------------------------------------------------------------------

describe('C13: a same-size setGeometry is a no-op, but handleResize still pushes to the daemon and broadcasts', () => {
  it('same-size handleResize: revision frozen, daemon resize sent, geometry frame broadcast', () => {
    const { terminal, toDaemon } = makeTerminal()
    const controller = controllerOf(terminal, 'c-same')
    const spectator = makeClient('c-same-spectator')
    terminal.attachClient(spectator)
    toDaemon.length = 0
    controller.sent.length = 0
    spectator.sent.length = 0

    const before = terminal.geometryRevision
    terminal.handleResize(controller.id, GEO.cols, GEO.rows) // exactly the current size

    expect(terminal.geometryRevision).toBe(before) // setGeometry returned early
    expect(resizesTo(toDaemon)).toEqual([{ cols: 80, rows: 24 }]) // pushed anyway
    // …and broadcast anyway, carrying the UNCHANGED revision.
    expect(geometryFrames(spectator)).toEqual([
      { type: 'geometry', sessionId: SESSION, cols: 80, rows: 24, geometryRevision: before },
    ])
  })

  it('a DIFFERENT size does bump the revision, so the freeze above is the same-size rule', () => {
    const { terminal } = makeTerminal()
    const controller = controllerOf(terminal, 'c-diff')
    const before = terminal.geometryRevision
    terminal.handleResize(controller.id, 120, 40)
    expect(terminal.geometry).toEqual({ cols: 120, rows: 40 })
    expect(terminal.geometryRevision).toBe(before + 1)
  })
})

// ---------------------------------------------------------------------------
// C15
// ---------------------------------------------------------------------------

describe('C15: spawn hardcodes DEFAULT_GEOMETRY, create() accepts no geometry, wake uses the stored one', () => {
  it('DEFAULT_GEOMETRY is 80x24 and is what a spawn frame and the published row both carry', () => {
    expect(DEFAULT_GEOMETRY).toEqual({ cols: 80, rows: 24 })
    const { reg, daemon } = registryFor()
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })

    expect(spawns(daemon).at(-1)?.geometry).toEqual({ cols: 80, rows: 24 })
    const row = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(row?.geometry).toEqual({ cols: 80, rows: 24 })
  })

  it('create() has no geometry parameter: an extra key is not read, and the spawn is still 80x24', () => {
    const { reg, daemon } = registryFor()
    const input = { agentKind: 'shell' as const, cwd: '/w' }
    // @ts-expect-error — the claim: SessionStart.create accepts NO geometry. If a
    // geometry input is ever added this line stops erroring and typecheck fails,
    // which is the point.
    input.geometry = { cols: 200, rows: 60 }
    const { sessionId } = reg.modules.sessions.createSession(input)

    expect(spawns(daemon).at(-1)?.geometry).toEqual({ cols: 80, rows: 24 })
    const row = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(row?.geometry).toEqual({ cols: 80, rows: 24 })
  })

  it('wake carries the STORED geometry, not the default', async () => {
    const { reg, daemon } = registryFor()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    // A resurrect only respawns a session it can resume; without the ref it
    // reports ok and sends the daemon nothing.
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'abc-123' },
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/w',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    const session = (reg as unknown as InternalRegistry).modules.sessions.sessions.get(sessionId)
    expect(session).toBeDefined()

    // Move the server's cached geometry the way a controller resize would.
    const client = makeClient('c-wake')
    client.viewVisible.add(sessionId)
    client.viewModes = { [sessionId]: 'native' }
    session?.terminal.attachClient(client)
    session?.terminal.handleResize(client.id, 132, 43)
    expect(session?.terminal.geometry).toEqual({ cols: 132, rows: 43 })

    reg.modules.sessions.hibernateSession({ sessionId })
    daemon.length = 0
    expect(await reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })).toEqual({
      ok: true,
    })

    // The stored grid, NOT DEFAULT_GEOMETRY — the one spawn path that carries a
    // viewer-derived size, and it carries it from the server's cache.
    expect(spawns(daemon).at(-1)?.geometry).toEqual({ cols: 132, rows: 43 })
  })
})

// ---------------------------------------------------------------------------
// C10 (server + wire half; the "nobody reads it" half is in terminal-client)
// ---------------------------------------------------------------------------

describe('C10: SessionMeta.geometry is a required field carrying the server value to the client row', () => {
  it('the schema REFUSES a session row without geometry', () => {
    const { reg } = registryFor()
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const row = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(row).toBeDefined()
    expect(SessionMeta.safeParse(row).success).toBe(true)

    const { geometry: _dropped, ...withoutGeometry } = row as SessionMeta
    const refused = SessionMeta.safeParse(withoutGeometry)
    expect(refused.success).toBe(false)
    expect(refused.error?.issues.some((i) => i.path.join('.') === 'geometry')).toBe(true)
  })

  it('the published row tracks the terminal geometry, so the value the panel could read is the server W', () => {
    const { reg } = registryFor()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/w',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    const session = (reg as unknown as InternalRegistry).modules.sessions.sessions.get(sessionId)
    const client = makeClient('c-row')
    client.viewVisible.add(sessionId)
    client.viewModes = { [sessionId]: 'native' }
    session?.terminal.attachClient(client)
    session?.terminal.handleResize(client.id, 132, 43)

    const row = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(row?.geometry).toEqual({ cols: 132, rows: 43 })
  })
})
