import { CLIENT_WIRE_VERSION } from '@podium/protocol'
/**
 * The server's two sizing rules (POD-4771, POD-3190 design rev 3).
 *
 * Rule 2 — RECONCILE. On a viewport statement, a controller change or a bind:
 * if the controller is visible and native, and its viewport differs from
 * `lastForwarded`, forward it and set `lastForwarded`. A bind sets
 * `lastForwarded` to the size it carries. Nothing else forwards, so the rule
 * cannot loop and needs no timer, watermark or retry.
 *
 * Rule 3 — BROADCAST ON CHANGE. The daemon's report and its bind are the only
 * writers of the server's copy, and each broadcasts only when the size moved.
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type Geometry,
  type SessionId,
} from '@podium/model'
import {
  CAP_DAEMON_GEOMETRY_APPLIED,
  type ServerMessage,
  type ViewportRequestMessage,
} from '@podium/protocol'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { userClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionRegistry } from '../../relay'
import { assignHostMachine, confirmingRetirement } from '../../test-support/host-daemon'
import { SessionClientControl } from './client-control'
import { SessionInbox } from './inbox'
import { Session } from './session'
import { SessionTerminal } from './terminal'

const SESSION = asSessionId('s-reconcile')
const MACHINE = asMachineId('m-reconcile')
const OWNER = asUserId(firstAdminMemberId())
const GEO: Geometry = { cols: 80, rows: 24 }
const BOX: Geometry = { cols: 132, rows: 43 }

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
    wireVersion: CLIENT_WIRE_VERSION,
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
    sent,
  }
}

function makeTerminal(): { terminal: SessionTerminal; toDaemon: ControlMessage[] } {
  const toDaemon: ControlMessage[] = []
  const terminal = new SessionTerminal({
    sessionId: SESSION,
    agentKind: 'claude-code',
    geometry: { ...GEO },
    toDaemon: (m) => toDaemon.push(m),
  })
  return { terminal, toDaemon }
}

/** Attached, visible, native — and therefore the controller of a fresh terminal. */
function viewer(terminal: SessionTerminal, id: string, sessionId: SessionId = SESSION): Sent {
  const client = makeClient(id)
  client.viewVisible.add(sessionId)
  client.viewModes = { [sessionId]: 'native' }
  terminal.attachClient(client)
  return client
}

/** A whole `viewportRequest` frame body, as a browser sends it today. */
const statement = (
  geometry: Geometry,
  over: { claimControl?: boolean; visible?: boolean; seq?: number } = {},
): Omit<ViewportRequestMessage, 'type' | 'sessionId'> => ({
  geometry,
  visible: over.visible ?? true,
  mode: 'native',
  claimControl: over.claimControl ?? false,
  seq: over.seq ?? 1,
})

const resizes = (toDaemon: ControlMessage[]) =>
  toDaemon
    .filter((m): m is Extract<ControlMessage, { type: 'resize' }> => m.type === 'resize')
    .map((m) => ({ cols: m.cols, rows: m.rows }))
const redraws = (toDaemon: ControlMessage[]) => toDaemon.filter((m) => m.type === 'redraw')
const sizeFrames = (client: Sent) =>
  client.sent.filter((m) => m.type === 'geometry' || m.type === 'controllerChanged')

describe('rule 2: reconcile against lastForwarded', () => {
  it('a statement from the visible native controller is forwarded once; the same box again is not', () => {
    const { terminal, toDaemon } = makeTerminal()
    const c = viewer(terminal, 'c1')
    terminal.handleViewportRequest(c.id, statement(BOX))
    terminal.handleViewportRequest(c.id, statement(BOX))
    expect(resizes(toDaemon)).toEqual([BOX])
  })

  it('a forward writes nothing: the copy moves only on the report', () => {
    // The compatibility branch that wrote the copy on forward for a daemon
    // without the report capability is gone, so no init can bring it back.
    const { terminal } = makeTerminal()
    const c = viewer(terminal, 'c1')
    c.sent.length = 0
    terminal.handleViewportRequest(c.id, statement(BOX))
    expect(terminal.geometry).toEqual(GEO)
    expect(sizeFrames(c)).toEqual([])
  })

  it('a box that goes back before the report lands is forwarded at once', () => {
    const { terminal, toDaemon } = makeTerminal()
    const c = viewer(terminal, 'c1')
    terminal.handleViewportRequest(c.id, statement(BOX))
    terminal.handleViewportRequest(c.id, statement(GEO))
    expect(resizes(toDaemon)).toEqual([BOX, GEO])
  })

  it('there is no seq watermark: a statement with a repeated seq is still a statement', () => {
    const { terminal, toDaemon } = makeTerminal()
    const c = viewer(terminal, 'c1')
    terminal.handleViewportRequest(c.id, statement(BOX))
    terminal.handleViewportRequest(c.id, statement({ cols: 100, rows: 30 }, { seq: 1 }))
    expect(resizes(toDaemon)).toEqual([BOX, { cols: 100, rows: 30 }])
  })

  it('visibility is read from viewState only: a statement that says visible is held until viewState agrees', () => {
    const { terminal, toDaemon } = makeTerminal()
    const c = makeClient('c1')
    terminal.attachClient(c)
    // The message claims visible+native, the stored viewState does not.
    terminal.handleViewportRequest(c.id, statement(BOX, { visible: true }))
    expect(resizes(toDaemon)).toEqual([])
    // The viewState that reveals it is a trigger, and forwards the box it holds.
    c.viewVisible.add(SESSION)
    c.viewModes = { [SESSION]: 'native' }
    terminal.reconcile()
    expect(resizes(toDaemon)).toEqual([BOX])
  })

  it('a spectator statement is recorded, not forwarded; a controller change forwards it with no redraw', () => {
    const { terminal, toDaemon } = makeTerminal()
    const desktop = viewer(terminal, 'desktop')
    const phone = viewer(terminal, 'phone')
    expect(terminal.controllerId).toBe(desktop.id)
    toDaemon.length = 0 // the attaches asked for their snapshot; not a redraw of the child
    terminal.handleViewportRequest(phone.id, statement({ cols: 62, rows: 36 }))
    expect(resizes(toDaemon)).toEqual([])

    terminal.requestControl(phone.id)
    expect(terminal.controllerId).toBe(phone.id)
    expect(resizes(toDaemon)).toEqual([{ cols: 62, rows: 36 }])
    expect(redraws(toDaemon)).toEqual([])
  })

  it('a claim WITH a size change forwards the size and sends no redraw', () => {
    const { terminal, toDaemon } = makeTerminal()
    viewer(terminal, 'desktop')
    const phone = viewer(terminal, 'phone')
    toDaemon.length = 0
    terminal.handleViewportRequest(
      phone.id,
      statement({ cols: 62, rows: 36 }, { claimControl: true }),
    )
    expect(terminal.controllerId).toBe(phone.id)
    expect(resizes(toDaemon)).toEqual([{ cols: 62, rows: 36 }])
    expect(redraws(toDaemon)).toEqual([])
  })

  it('the desktop leaving hands control to the phone and forwards the phone box', () => {
    const { terminal, toDaemon } = makeTerminal()
    const desktop = viewer(terminal, 'desktop')
    terminal.handleViewportRequest(desktop.id, statement(BOX))
    const phone = viewer(terminal, 'phone')
    terminal.handleViewportRequest(phone.id, statement({ cols: 62, rows: 36 }))
    toDaemon.splice(0, toDaemon.length, ...toDaemon.filter((m) => m.type !== 'redraw'))
    terminal.detachClient(desktop.id)
    expect(terminal.controllerId).toBe(phone.id)
    expect(resizes(toDaemon)).toEqual([BOX, { cols: 62, rows: 36 }])
    expect(redraws(toDaemon)).toEqual([])
  })
})

describe('rule 2 on bind, and rule 3 (report and bind broadcast only on change)', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  interface InternalRegistry {
    modules: { sessions: { sessions: Map<string, Session> } }
  }

  /** A daemon that advertises the report capability, as every current daemon
   *  does — so the base's reporting path (and its watchdog) is what these
   *  tests were proven red against, not the compatibility branch. */
  async function attachDaemon(reg: SessionRegistry, sink: ControlMessage[]): Promise<void> {
    const machineId = reg.sessionStore.hostMachineId
    await assignHostMachine(reg.sessionStore)
    await reg.gateway.attachDaemon(
      machineId,
      confirmingRetirement(reg, machineId, (m: ControlMessage) => sink.push(m)),
      [CAP_DAEMON_GEOMETRY_APPLIED],
    )
  }

  /** A live session bound at GEO, with one visible native controller. */
  async function watched(): Promise<{
    reg: SessionRegistry
    daemon: ControlMessage[]
    sessionId: SessionId
    session: Session
    client: Sent
    rows: () => Promise<number>
  }> {
    const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(reg)
    const daemon: ControlMessage[] = []
    await attachDaemon(reg, daemon)
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId, GEO))
    const internal = reg as unknown as InternalRegistry
    const session = internal.modules.sessions.sessions.get(sessionId) as Session
    const client = viewer(session.terminal, 'c-watch', sessionId)
    // The ROW travels through the volatile seam and the change log, which is
    // what a delta client syncs from. Count this session's captured upserts.
    await reg.modules.sessions.flushBroadcasts()
    let published = 0
    reg.modules.sessions.onSessionProjection((event) => {
      published += event.changes.filter((change) => change.id === sessionId).length
    })
    client.sent.length = 0
    daemon.length = 0
    const rows = async (): Promise<number> => {
      await reg.modules.sessions.flushBroadcasts()
      return published
    }
    return { reg, daemon, sessionId, session, client, rows }
  }

  const bind = (
    sessionId: SessionId,
    geometry?: Geometry,
  ): Extract<DaemonMessage, { type: 'bind' }> => ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/w',
    agentKind: 'claude-code',
    ...(geometry ? { geometry } : {}),
  })
  const report = (sessionId: SessionId, geometry: Geometry): DaemonMessage => ({
    type: 'geometryApplied',
    sessionId,
    geometry,
    cause: 'request',
  })

  it('LINK B LOST THE ASK: a rebind at the old size re-drives the controller box', async () => {
    const { reg, daemon, sessionId, session, client } = await watched()
    session.terminal.handleViewportRequest(client.id, statement(BOX))
    expect(resizes(daemon)).toEqual([BOX])

    // Link B drops before the daemon reads the resize; it comes back and binds
    // with the size the host still has.
    reg.gateway.detachDaemon(reg.sessionStore.hostMachineId)
    const after: ControlMessage[] = []
    await attachDaemon(reg, after)
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId, GEO))
    expect(resizes(after)).toEqual([BOX])
  })

  it('a rebind at the box the controller holds forwards nothing', async () => {
    const { reg, sessionId, session, client } = await watched()
    session.terminal.handleViewportRequest(client.id, statement(BOX))
    reg.gateway.detachDaemon(reg.sessionStore.hostMachineId)
    const after: ControlMessage[] = []
    await attachDaemon(reg, after)
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId, BOX))
    expect(resizes(after)).toEqual([])
    expect(session.terminal.geometry).toEqual(BOX)
  })

  it('a bare bind (a backend that cannot read its size) keeps the copy and re-drives the box', async () => {
    const { reg, sessionId, session, client } = await watched()
    session.terminal.handleViewportRequest(client.id, statement(BOX))
    reg.gateway.detachDaemon(reg.sessionStore.hostMachineId)
    const after: ControlMessage[] = []
    await attachDaemon(reg, after)
    client.sent.length = 0
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId))
    expect(session.terminal.geometry).toEqual(GEO)
    expect(sizeFrames(client)).toEqual([])
    expect(resizes(after)).toEqual([BOX])
  })

  it('an EQUAL report writes nothing and broadcasts nothing', async () => {
    const { reg, sessionId, client, rows } = await watched()
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, report(sessionId, GEO))
    expect(sizeFrames(client)).toEqual([])
    expect(await rows()).toBe(0)
  })

  it('a CHANGED report writes the copy, sends one geometry frame with no revision, and republishes the row', async () => {
    const { reg, sessionId, session, client, rows } = await watched()
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, report(sessionId, BOX))
    expect(session.terminal.geometry).toEqual(BOX)
    expect(client.sent.filter((m) => m.type === 'geometry')).toEqual([
      { type: 'geometry', sessionId, cols: BOX.cols, rows: BOX.rows },
    ])
    expect(await rows()).toBe(1)
  })

  it('a report never forwards: forwards come only from statements, controller changes and binds', async () => {
    const { reg, daemon, sessionId, session, client } = await watched()
    session.terminal.handleViewportRequest(client.id, statement(BOX))
    daemon.length = 0
    // The host refused BOX and something else moved the kernel: the report says so.
    await reg.gateway.routeDaemonFrame(
      reg.sessionStore.hostMachineId,
      report(sessionId, { cols: 90, rows: 30 }),
    )
    expect(resizes(daemon)).toEqual([])
  })

  it('no watchdog: a forward arms no timer, and an unanswered ask is never retried', async () => {
    const { daemon, session, client } = await watched()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      session.terminal.handleViewportRequest(client.id, statement(BOX))
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      session.terminal.handleViewportRequest(client.id, statement(BOX))
      expect(resizes(daemon)).toEqual([BOX])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a BIRTH report acts as a bind: it re-drives a box the daemon dropped; a plain report does not', async () => {
    // A client TUI that was not open: the box was forwarded (lastForwarded =
    // BOX) and dropped by a daemon with no terminal. The TUI then opens at the
    // last-known size, and its WELCOME arrives as a report marked `birth`.
    const { reg, daemon, sessionId, session, client } = await watched()
    session.terminal.handleViewportRequest(client.id, statement(BOX))
    expect(resizes(daemon)).toEqual([BOX])
    daemon.length = 0

    // ARMED: the same size as a plain (RESIZED) report forwards nothing.
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, report(sessionId, GEO))
    expect(resizes(daemon)).toEqual([])

    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      ...report(sessionId, GEO),
      birth: true,
    } as DaemonMessage)
    expect(resizes(daemon)).toEqual([BOX])
  })

  it('a bind at the same size broadcasts nothing', async () => {
    const { reg, sessionId, client } = await watched()
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, bind(sessionId, GEO))
    expect(client.sent.filter((m) => m.type === 'geometry')).toEqual([])
  })

  it('the row and the attach frame carry no knowledge state, revision or duplicate counter', async () => {
    const { reg, sessionId, session } = await watched()
    const row = (await reg.modules.sessions.listSessions(undefined, 'rpc')).find(
      (s) => s.sessionId === sessionId,
    )
    expect(row).toBeDefined()
    expect(row && 'geometryState' in row).toBe(false)
    expect(row && 'requestsDuplicate' in row).toBe(false)
    expect(row && 'requestsUnanswered' in row).toBe(false)
    const late = makeClient('c-late')
    session.terminal.attachClient(late)
    const attached = late.sent.find((m) => m.type === 'attached')
    expect(attached && 'geometryRevision' in attached).toBe(false)
    expect(attached && 'geometryState' in attached).toBe(false)
  })

  it('a durable-write rollback leaves the copy alone: only the report and the bind write it', async () => {
    const { reg, sessionId, session, client } = await watched()
    const before = session.captureDurableState()
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, report(sessionId, BOX))
    client.sent.length = 0
    session.restoreDurableState(before)
    expect(session.terminal.geometry).toEqual(BOX)
    expect(sizeFrames(client)).toEqual([])
  })
})

describe('repaint', () => {
  it('the user redraw button sends Ctrl-L; attach requests no repaint', async () => {
    const toDaemon: ControlMessage[] = []
    const session = new Session({
      sessionId: SESSION,
      durableLabel: 'podium-s-reconcile',
      agentKind: 'claude-code',
      cwd: '/w',
      title: 'w',
      origin: { kind: 'spawn' },
      createdAt: '2026-09-28T00:00:00.000Z',
      geometry: GEO,
      machineId: MACHINE,
      ownerUserId: OWNER,
      toDaemon: (m: ControlMessage) => toDaemon.push(m),
    })
    const inbox = new SessionInbox({
      getSession: (id: SessionId) => (id === SESSION ? session : undefined),
      authorizeDrive: async () => true,
    } as never)
    const ctl = new SessionClientControl({
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
      sessionOwner: async () => ({ owner: OWNER, grants: [] }),
      machineUseFor: async () => 'granted' as const,
    } as never)
    const client = makeClient('c-redraw')
    await ctl.onFrame(client.principal, client, { type: 'attach', sessionId: SESSION })
    expect(redraws(toDaemon)).toEqual([])
    toDaemon.length = 0
    await ctl.onFrame(client.principal, client, { type: 'redrawRequest', sessionId: SESSION })
    expect(redraws(toDaemon)).toEqual([{ type: 'redraw', sessionId: SESSION, hard: true }])
  })
})
