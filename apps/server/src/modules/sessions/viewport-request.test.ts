/**
 * T3 / T4 / T5 (POD-3239 SPEC-1 acceptance) — the server's request path.
 *
 * The three things B6 adds on top of the machinery the 0b claims pin
 * (`terminal-sizing-claims.test.ts`): the per-(connection, session) seq
 * watermark, the `geometryState` lifecycle, and the compatibility branch for a
 * daemon that does not report the grid it applied.
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  FIRST_ADMIN_USER_ID,
  type Geometry,
} from '@podium/model'
import { CAP_DAEMON_GEOMETRY_APPLIED, type ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { userClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'
import { Session } from './session'
import { SessionTerminal, type ViewportRequest } from './terminal'

const SESSION = asSessionId('s-request')
const MACHINE = asMachineId('m-request')
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
    viewportSeq: new Map(),
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

/** The real SessionTerminal over a recording daemon channel. `reports` is the
 *  capability under test in T5: whether this session's daemon sends
 *  `geometryApplied`. */
function makeTerminal(reports: boolean): {
  terminal: SessionTerminal
  toDaemon: ControlMessage[]
} {
  const toDaemon: ControlMessage[] = []
  const terminal = new SessionTerminal({
    sessionId: SESSION,
    agentKind: 'claude-code',
    geometry: { ...GEO },
    toDaemon: (m) => toDaemon.push(m),
    daemonReportsGeometry: () => reports,
  })
  return { terminal, toDaemon }
}

/** Attached, visible, native, and controller. */
function controllerOf(terminal: SessionTerminal, id = 'c1'): Sent {
  const client = makeClient(id)
  client.viewVisible.add(SESSION)
  client.viewModes = { [SESSION]: 'native' }
  terminal.attachClient(client)
  expect(terminal.controllerId).toBe(client.id)
  return client
}

const request = (over: Partial<ViewportRequest> = {}): ViewportRequest => ({
  geometry: { cols: 132, rows: 43 },
  visible: true,
  mode: 'native',
  claimControl: false,
  seq: 1,
  ...over,
})

const resizesTo = (toDaemon: ControlMessage[]) =>
  toDaemon
    .filter((m): m is Extract<ControlMessage, { type: 'resize' }> => m.type === 'resize')
    .map((m) => ({ cols: m.cols, rows: m.rows }))

// ---------------------------------------------------------------------------
// T3 — the watermark
// ---------------------------------------------------------------------------

describe('T3: the seq watermark is per (connection, session), and every rejection is counted', () => {
  it('a request that OVERTAKES its own viewState is accepted, because the gate reads the MESSAGE', () => {
    // THE REGRESSION THIS EXISTS TO PREVENT. A reveal sends its `viewState` and
    // its request from the same tick; either can arrive first. Judging the
    // request against stored `viewState` means a correct request is refused for
    // being early — and the client, having no refusal frame to react to, simply
    // stays at the wrong size. Here the connection's stored viewState still says
    // "not visible", and the request is accepted on its own `visible: true`.
    const { terminal, toDaemon } = makeTerminal(true)
    const client = makeClient('c-early')
    terminal.attachClient(client)
    expect(client.viewVisible.has(SESSION)).toBe(false) // viewState has not landed
    toDaemon.length = 0

    terminal.handleViewportRequest(client.id, request())

    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])
    expect(terminal.requestsGated).toBe(0)
  })

  it('a CLAIMING request that overtakes its viewState is accepted too — and its size lands', () => {
    // The same race as the test above, on the path where getting it wrong is
    // worse: `requestControl` reads the connection's STORED visibility, so a
    // claim that overtook its own `viewState` used to transfer control and then
    // decline the geometry — leaving the pty at the grid the PREVIOUS viewer had
    // while the new controller rendered something else. The message's own
    // `visible` travels with the claim.
    const { terminal, toDaemon } = makeTerminal(true)
    const owner = controllerOf(terminal, 'c-owner')
    const claimer = makeClient('c-early-claim')
    terminal.attachClient(claimer)
    expect(claimer.viewVisible.has(SESSION)).toBe(false) // viewState has not landed
    toDaemon.length = 0
    owner.sent.length = 0

    terminal.handleViewportRequest(claimer.id, request({ claimControl: true }))

    expect(terminal.controllerId).toBe(claimer.id)
    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])
  })

  it('ARMED: a claim that says it is NOT rendering takes control without moving the pty', () => {
    // The counterfactual. `visible: false` is a client saying "I am not showing
    // this" — a chat surface claiming input, say — and a size from something not
    // on screen must not become the pty's.
    const { terminal, toDaemon } = makeTerminal(true)
    controllerOf(terminal, 'c-owner')
    const claimer = makeClient('c-blind-claim')
    claimer.viewVisible.add(SESSION)
    terminal.attachClient(claimer)
    toDaemon.length = 0

    terminal.handleViewportRequest(claimer.id, request({ claimControl: true, visible: false }))

    expect(terminal.controllerId).toBe(claimer.id)
    expect(resizesTo(toDaemon)).toEqual([])
  })

  it('a duplicate seq is REJECTED and counted, and nothing about it is applied', () => {
    const { terminal, toDaemon } = makeTerminal(true)
    const client = controllerOf(terminal, 'c-dupe')
    toDaemon.length = 0

    terminal.handleViewportRequest(client.id, request({ seq: 4 }))
    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])

    // The same seq again — a retransmit — and an EARLIER one, which is a request
    // that lost a race. Neither may re-apply, and the stale one must not
    // overwrite the recorded viewport with its out-of-date box.
    terminal.handleViewportRequest(client.id, request({ seq: 4, geometry: { cols: 10, rows: 5 } }))
    terminal.handleViewportRequest(client.id, request({ seq: 2, geometry: { cols: 11, rows: 6 } }))

    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])
    expect(client.viewports.get(SESSION)).toEqual({ cols: 132, rows: 43 })
    expect(terminal.requestsDuplicate).toBe(2)
    // A duplicate is a retransmit, not a refusal — it is counted separately so
    // the refusal signal stays readable.
    expect(terminal.requestsGated).toBe(0)

    // ARMED: a HIGHER seq on the same connection is still accepted.
    terminal.handleViewportRequest(client.id, request({ seq: 5, geometry: { cols: 90, rows: 30 } }))
    expect(resizesTo(toDaemon).at(-1)).toEqual({ cols: 90, rows: 30 })
  })

  it('a GATED request advances the watermark — it was processed, not lost', () => {
    const { terminal, toDaemon } = makeTerminal(true)
    const client = controllerOf(terminal, 'c-gated')
    toDaemon.length = 0

    // Refused: the sender says it is rendering CHAT, so it is not a viewer of
    // this terminal and does not get to size it.
    terminal.handleViewportRequest(client.id, request({ seq: 7, mode: 'chat' }))
    expect(resizesTo(toDaemon)).toEqual([])
    expect(terminal.requestsGated).toBe(1)

    // …and seq 7 is now spent. A client that re-sent it would be a duplicate.
    terminal.handleViewportRequest(client.id, request({ seq: 7 }))
    expect(terminal.requestsDuplicate).toBe(1)
    expect(resizesTo(toDaemon)).toEqual([])

    // Its NEXT ask carries a higher seq and is honoured.
    terminal.handleViewportRequest(client.id, request({ seq: 8 }))
    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])
  })

  it('a NEW connection starts a new watermark, so a reconnect at seq 1 is not a duplicate', () => {
    // The watermark lives on the ClientConn and dies with the socket. That is
    // the whole reason a reconnected client may legitimately start again at 1.
    const { terminal, toDaemon } = makeTerminal(true)
    const first = controllerOf(terminal, 'c-socket-1')
    terminal.handleViewportRequest(first.id, request({ seq: 9 }))
    terminal.detachClient(first.id)
    toDaemon.length = 0

    const second = makeClient('c-socket-2')
    second.viewVisible.add(SESSION)
    second.viewModes = { [SESSION]: 'native' }
    terminal.attachClient(second)

    terminal.handleViewportRequest(second.id, request({ seq: 1, geometry: { cols: 70, rows: 20 } }))

    expect(resizesTo(toDaemon)).toEqual([{ cols: 70, rows: 20 }])
    expect(terminal.requestsDuplicate).toBe(0)
  })

  it('a claiming request takes control and forwards its size in one mutation', () => {
    const { terminal, toDaemon } = makeTerminal(true)
    const owner = controllerOf(terminal, 'c-owner')
    const claimer = makeClient('c-claimer')
    claimer.viewVisible.add(SESSION)
    claimer.viewModes = { [SESSION]: 'native' }
    terminal.attachClient(claimer)
    toDaemon.length = 0
    owner.sent.length = 0

    const changed = terminal.handleViewportRequest(
      claimer.id,
      request({ claimControl: true, seq: 1 }),
    )

    expect(changed).toBe(true)
    expect(terminal.controllerId).toBe(claimer.id)
    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])
    expect(owner.sent.filter((m) => m.type === 'controllerChanged')).toHaveLength(1)
  })

  it('a reveal that claims at the size W ALREADY is causes no resize at all (T9, server half)', () => {
    // 0a's cold-sized capture: the server already held 104x31 and the mount
    // pushed it to 104x33 and back. Rule 4 keeps the always-send claim; this is
    // what stops it costing a SIGWINCH.
    const toDaemon: ControlMessage[] = []
    const terminal = new SessionTerminal({
      sessionId: SESSION,
      agentKind: 'claude-code',
      geometry: { cols: 104, rows: 31 },
      toDaemon: (m) => toDaemon.push(m),
      daemonReportsGeometry: () => true,
    })
    const client = controllerOf(terminal, 'c-cold')
    toDaemon.length = 0
    const revisionBefore = terminal.geometryRevision

    terminal.handleViewportRequest(
      client.id,
      request({ claimControl: true, geometry: { cols: 104, rows: 31 }, seq: 1 }),
    )

    expect(resizesTo(toDaemon)).toEqual([])
    expect(terminal.geometryRevision).toBe(revisionBefore)
  })
})

// ---------------------------------------------------------------------------
// T4 — the geometryState lifecycle
// ---------------------------------------------------------------------------

describe('T4: every geometryState transition (MODEL rule 6)', () => {
  const sessionWith = (
    over: Partial<ConstructorParameters<typeof Session>[0]> = {},
  ): Session =>
    new Session({
      sessionId: SESSION,
      durableLabel: 'podium-s-request',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: '2026-09-02T00:00:00.000Z',
      geometry: { ...GEO },
      machineId: MACHINE,
      ownerUserId: OWNER,
      toDaemon: vi.fn(),
      ...over,
    })

  it('a fresh session is `unknown`: it has a last-known grid and nothing standing behind it', () => {
    expect(sessionWith().geometryState()).toBe('unknown')
  })

  it('BIND makes it `current`', () => {
    const s = sessionWith()
    s.markLive('claude', { cols: 132, rows: 43 })
    expect(s.geometryState()).toBe('current')
    expect(s.terminal.geometry).toEqual({ cols: 132, rows: 43 })
  })

  it('a `geometryApplied` report makes it `current` too', () => {
    const s = sessionWith()
    s.terminal.applyDaemonGeometry({ cols: 100, rows: 30 })
    expect(s.geometryState()).toBe('current')
  })

  it('DAEMON LOSS drops it back to `unknown` — and KEEPS the grid, which still renders', () => {
    const s = sessionWith({ status: 'live' })
    s.markLive('claude', { cols: 132, rows: 43 })
    expect(s.geometryState()).toBe('current')

    expect(s.markReconnecting()).toBe(true)

    expect(s.geometryState()).toBe('unknown')
    // Rule 6: last-known renders during `unknown`, because inside the system W
    // can only change through a daemon.
    expect(s.terminal.geometry).toEqual({ cols: 132, rows: 43 })
  })

  it('REHYDRATION is `unknown` without anyone having to remember to say so', () => {
    // A restarted server rebuilds rows from the store, which is a fresh Session
    // construction — so the confirmed bit starts false by construction rather
    // than by a transition somebody could forget to write.
    const rehydrated = sessionWith({ status: 'reconnecting' })
    expect(rehydrated.geometryState()).toBe('unknown')
    expect(rehydrated.terminal.geometry).toEqual(GEO)
  })

  it('HIBERNATE and EXIT are `absent` — no pty, so the panel shows the transcript', () => {
    const hibernated = sessionWith({ status: 'live' })
    hibernated.markLive('claude', { cols: 132, rows: 43 })
    hibernated.status = 'hibernated'
    expect(hibernated.geometryState()).toBe('absent')

    const exited = sessionWith({ status: 'live' })
    exited.markLive('claude', { cols: 132, rows: 43 })
    exited.onExit(0)
    expect(exited.geometryState()).toBe('absent')
  })

  it('a SPAWN FAILURE is `absent`', () => {
    const s = sessionWith()
    s.markSpawnError('no such command')
    expect(s.geometryState()).toBe('absent')
  })

  it('a WAKE goes absent → unknown → current, and the row carries it each time', () => {
    const s = sessionWith({ status: 'live' })
    s.markLive('claude', { cols: 132, rows: 43 })
    s.status = 'hibernated'
    expect(s.geometryState()).toBe('absent')

    // Resurrect: the row is live again but nothing has bound yet.
    s.status = 'starting'
    s.terminal.markGeometryUnknown()
    expect(s.geometryState()).toBe('unknown')

    s.markLive('claude', { cols: 132, rows: 43 })
    expect(s.geometryState()).toBe('current')
  })

  it('the attach frame carries the session state, not the terminal’s half of it', () => {
    const s = sessionWith({ status: 'live' })
    s.status = 'exited'
    const client = makeClient('c-attach')
    s.terminal.attachClient(client)
    const attached = client.sent.find((m) => m.type === 'attached')
    expect(attached).toMatchObject({ geometryState: 'absent' })
  })
})

// ---------------------------------------------------------------------------
// T5 — legacy frames, and the one compatibility branch
// ---------------------------------------------------------------------------

describe('T5: the legacy frames still work, and an old daemon still gets a moving W', () => {
  it('a legacy `resize` is a non-claiming request with visible/mode from stored viewState', () => {
    const { terminal, toDaemon } = makeTerminal(true)
    const client = controllerOf(terminal, 'c-legacy')
    toDaemon.length = 0

    terminal.handleResize(client.id, 120, 40)

    expect(resizesTo(toDaemon)).toEqual([{ cols: 120, rows: 40 }])
    expect(client.viewports.get(SESSION)).toEqual({ cols: 120, rows: 40 })
  })

  it('a legacy resize NEVER touches the watermark, so old and new clients cannot fight over it', () => {
    const { terminal, toDaemon } = makeTerminal(true)
    const client = controllerOf(terminal, 'c-mixed')
    toDaemon.length = 0

    terminal.handleResize(client.id, 120, 40)
    terminal.handleResize(client.id, 121, 41)
    expect(resizesTo(toDaemon)).toEqual([
      { cols: 120, rows: 40 },
      { cols: 121, rows: 41 },
    ])
    expect(terminal.requestsDuplicate).toBe(0)

    // …and a real request at seq 1 is still new.
    terminal.handleViewportRequest(client.id, request({ seq: 1, geometry: { cols: 90, rows: 30 } }))
    expect(resizesTo(toDaemon).at(-1)).toEqual({ cols: 90, rows: 30 })
  })

  it('a legacy geometry-bearing `requestControl` still transfers control and forwards its size', () => {
    const { terminal, toDaemon } = makeTerminal(true)
    const owner = controllerOf(terminal, 'c-owner')
    const claimer = makeClient('c-legacy-claim')
    claimer.viewVisible.add(SESSION)
    claimer.viewModes = { [SESSION]: 'native' }
    terminal.attachClient(claimer)
    toDaemon.length = 0
    owner.sent.length = 0

    terminal.requestControl(claimer.id, { cols: 62, rows: 36 })

    expect(terminal.controllerId).toBe(claimer.id)
    expect(resizesTo(toDaemon)).toEqual([{ cols: 62, rows: 36 }])
    expect(owner.sent.filter((m) => m.type === 'controllerChanged')).toHaveLength(1)
  })

  it('WITH a reporting daemon the request writes NOTHING — the report does', () => {
    const { terminal, toDaemon } = makeTerminal(true)
    const client = controllerOf(terminal, 'c-modern')
    toDaemon.length = 0
    client.sent.length = 0
    const before = terminal.geometryRevision

    terminal.handleViewportRequest(client.id, request({ geometry: { cols: 120, rows: 40 } }))

    // Forwarded, and that is ALL: W has not moved and nobody has been told a
    // grid that is not yet true.
    expect(resizesTo(toDaemon)).toEqual([{ cols: 120, rows: 40 }])
    expect(terminal.geometry).toEqual(GEO)
    expect(terminal.geometryRevision).toBe(before)
    expect(client.sent.filter((m) => m.type === 'geometry')).toEqual([])

    // The daemon reports, and THAT is what moves W and announces it.
    terminal.applyDaemonGeometry({ cols: 120, rows: 40 })
    expect(terminal.geometry).toEqual({ cols: 120, rows: 40 })
    expect(client.sent.filter((m) => m.type === 'geometry')).toHaveLength(1)
  })

  it('WITHOUT the capability the server keeps writing W itself, or it would never move again', () => {
    const { terminal, toDaemon } = makeTerminal(false)
    const client = controllerOf(terminal, 'c-old-daemon')
    toDaemon.length = 0
    client.sent.length = 0
    const before = terminal.geometryRevision

    terminal.handleViewportRequest(client.id, request({ geometry: { cols: 120, rows: 40 } }))

    expect(resizesTo(toDaemon)).toEqual([{ cols: 120, rows: 40 }])
    expect(terminal.geometry).toEqual({ cols: 120, rows: 40 })
    expect(terminal.geometryRevision).toBe(before + 1)
    expect(client.sent.filter((m) => m.type === 'geometry')).toHaveLength(1)
  })

  it('the capability is asked FOR EACH REQUEST, so a daemon downgrade takes effect immediately', () => {
    // A session outlives its daemon connection. Snapshotting the answer at
    // construction would keep a session on the modern path after its machine
    // reconnected with an older daemon — and W would then stop moving.
    let reports = true
    const toDaemon: ControlMessage[] = []
    const terminal = new SessionTerminal({
      sessionId: SESSION,
      agentKind: 'claude-code',
      geometry: { ...GEO },
      toDaemon: (m) => toDaemon.push(m),
      daemonReportsGeometry: () => reports,
    })
    const client = controllerOf(terminal, 'c-downgrade')

    terminal.handleViewportRequest(client.id, request({ geometry: { cols: 120, rows: 40 }, seq: 1 }))
    expect(terminal.geometry).toEqual(GEO) // modern path: forwarded only

    reports = false
    terminal.handleViewportRequest(client.id, request({ geometry: { cols: 121, rows: 41 }, seq: 2 }))
    expect(terminal.geometry).toEqual({ cols: 121, rows: 41 }) // fallback path: written
  })
})

// ---------------------------------------------------------------------------
// T5, the wiring half — the capability has to actually REACH the session
// ---------------------------------------------------------------------------

describe('T5 (wiring): the capability travels socket → machine registry → session', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  /** The live Session objects, which is what the branch under test hangs off. */
  interface InternalRegistry {
    modules: { sessions: { sessions: Map<string, Session> } }
  }

  const attachWith = (caps: string[]) => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registries.push(reg)
    const daemon: ControlMessage[] = []
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m: ControlMessage) => daemon.push(m), caps)
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    const session = (reg as unknown as InternalRegistry).modules.sessions.sessions.get(sessionId)
    expect(session).toBeDefined()
    return { reg, session: session as Session, daemon }
  }

  it('a session on a machine whose daemon advertised the cap takes the report path', () => {
    const { session, daemon } = attachWith([CAP_DAEMON_GEOMETRY_APPLIED])
    const client = controllerOf(session.terminal, 'c-wired')
    daemon.length = 0
    const before = session.terminal.geometry

    session.terminal.handleViewportRequest(
      client.id,
      request({ geometry: { cols: 111, rows: 41 } }),
    )

    expect(daemon.filter((m) => m.type === 'resize')).toHaveLength(1)
    expect(session.terminal.geometry).toEqual(before) // forwarded, not written
  })

  it('ARMED: the same session on a machine that advertised NOTHING takes the fallback', () => {
    const { session } = attachWith([])
    const client = controllerOf(session.terminal, 'c-unwired')

    session.terminal.handleViewportRequest(
      client.id,
      request({ geometry: { cols: 111, rows: 41 } }),
    )

    expect(session.terminal.geometry).toEqual({ cols: 111, rows: 41 })
  })

  it('a REHYDRATED session is wired to the capability too — the restart path has its own composition', () => {
    // The repository builds Sessions from stored rows on a server restart, and
    // it is a SECOND construction site: wiring the capability only into the
    // create path would leave every session that survived a restart on the
    // fallback branch, silently, forever.
    const store = new SessionStore(':memory:')
    const first = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(first)
    const { sessionId } = first.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })

    const restarted = new SessionRegistry(store, undefined, { instanceId: 'default' })
    registries.push(restarted)
    restarted.gateway.attachDaemon(restarted.sessionStore.hostMachineId, () => {}, [
      CAP_DAEMON_GEOMETRY_APPLIED,
    ])
    const session = (restarted as unknown as InternalRegistry).modules.sessions.sessions.get(
      sessionId,
    )
    expect(session).toBeDefined()
    const rehydrated = session as Session
    // Rehydration is also where `unknown` comes from (MODEL rule 6).
    expect(rehydrated.geometryState()).toBe('unknown')

    const client = controllerOf(rehydrated.terminal, 'c-restarted')
    const before = rehydrated.terminal.geometry
    rehydrated.terminal.handleViewportRequest(
      client.id,
      request({ geometry: { cols: 113, rows: 43 } }),
    )
    expect(rehydrated.terminal.geometry).toEqual(before) // report path, not fallback
  })

  it('the answer follows the LIVE socket: a detach takes the capability with it', () => {
    const { reg, session } = attachWith([CAP_DAEMON_GEOMETRY_APPLIED])
    const client = controllerOf(session.terminal, 'c-drop')
    session.terminal.handleViewportRequest(
      client.id,
      request({ geometry: { cols: 111, rows: 41 }, seq: 1 }),
    )
    expect(session.terminal.geometry).toEqual(GEO) // report path

    reg.gateway.detachDaemon(reg.sessionStore.hostMachineId)

    session.terminal.handleViewportRequest(
      client.id,
      request({ geometry: { cols: 112, rows: 42 }, seq: 2 }),
    )
    // No daemon, no reporter — so the server writes W itself rather than
    // freezing the grid behind a capability nothing is backing any more.
    expect(session.terminal.geometry).toEqual({ cols: 112, rows: 42 })
  })
})
