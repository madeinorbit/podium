/**
 * POD-1081 integration-shaped tests over SessionClientControl:
 * attach visibility + machine use, take-control policy, agent revoke at apply.
 */

import {
  asMachineId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { userClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionClientControl } from './client-control'
import type { SessionInbox } from './inbox'
import type { Session } from './session'
import { Session as SessionClass } from './session'

const geo = { cols: 80, rows: 24 }
const MACHINE = asMachineId('m-home')
const SESSION = asSessionId('s-shared')
const OWNER = asUserId(firstAdminMemberId())
const ALICE = asUserId('user:alice')

function makeSession(): Session {
  return new SessionClass({
    sessionId: SESSION,
    durableLabel: 'podium-s-shared',
    agentKind: 'claude-code',
    cwd: '/w',
    title: 'w',
    origin: { kind: 'spawn' },
    createdAt: '2026-06-03T00:00:00.000Z',
    geometry: geo,
    machineId: MACHINE,
    ownerUserId: OWNER,
    toDaemon: vi.fn(),
  })
}

function makeClient(
  id: string,
  user: UserId = OWNER,
  role: 'admin' | 'member' = 'admin',
): ClientConn & { sent: ServerMessage[]; principal: ClientPrincipal } {
  const sent: ServerMessage[] = []
  return {
    id,
    principal: userClientPrincipal(id, user, role),
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

function control(opts: {
  session: Session
  owner?: { owner: UserId; grants: string[] } | undefined
  machineUse?: 'granted' | 'denied' | 'absent'
  occupancy?: number
}): SessionClientControl {
  const sessions = new Map<SessionId, Session>([[SESSION, opts.session]])
  // Built first so inbox can close over authorizeDrive after construction.
  let ctl!: SessionClientControl
  const inbox = {
    handleControllerInput: vi.fn(),
    requestControl: async (
      principal: ClientPrincipal,
      client: ClientConn,
      sessionId: SessionId,
      geometry?: { cols: number; rows: number },
    ) => {
      // Mirror production: policy gate then transfer.
      if (!(await ctl.authorizeDrive(principal, sessionId))) {
        client.send({ type: 'terminalOutcome', sessionId, outcome: 'unauthorized' })
        return
      }
      opts.session.terminal.requestControl(client.id, geometry)
    },
    reconcileActiveRenderer: async (sessionId: SessionId) => {
      const [sole, second] = opts.session.terminal.activeNativeRenderers()
      if (!sole || second || !(await ctl.authorizeDrive(sole.principal, sessionId))) return
      opts.session.terminal.requestControl(sole.id)
    },
    handleResize: vi.fn(),
    reconcileGeometry: vi.fn(),
  } as unknown as SessionInbox

  ctl = new SessionClientControl({
    sessions,
    publication: { schedule: vi.fn(), prioritize: vi.fn() } as never,
    state: { replayDrafts: vi.fn(), handleDraftEdit: vi.fn() } as never,
    inbox,
    machinesForPrincipal: async () => [],
    browserOpen: { submitCallback: vi.fn(), dismiss: vi.fn() } as never,
    mutate: (_id: SessionId, change: (s: Session) => void) => change(opts.session),
    broadcastSessions: vi.fn(),
    pushPriorities: vi.fn(),
    setDraft: vi.fn(),
    editDraft: vi.fn(),
    // Both authorization ports are REQUIRED (POD-333). A fixture that omitted
    // `sessionOwner` used to get an OPEN attach; now it must say who the owner
    // is, and `owner: undefined` means "absent or invisible" — which denies,
    // rather than skipping the check.
    sessionOwner: async () => opts.owner,
    machineUseFor: async () => opts.machineUse ?? 'granted',
    sessionOccupancyCount: () => opts.occupancy,
  } as never)
  return ctl
}

describe('POD-1081 attach + take-control policy', () => {
  it('FAILS CLOSED when no owner can be resolved — even for the admin (POD-333)', async () => {
    // The half-migration this replaced: `sessionOwner` and `machineUseFor` were
    // OPTIONAL ports, and an unwired `sessionOwner` returned `true` from
    // authorizeAttach outright while `machineUseFor` defaulted to `'granted'`.
    // Production wired both, so nothing was exposed — but a gate that is skipped
    // when a dependency is missing is one refactor from being an unwired gate,
    // and docs/multi-user-readiness.md §3.1.4 M4 requires the opposite default.
    //
    // Both ports are required now (a fixture that omits one is a TYPE error:
    // TS2739, which is how the last fixture in this file was found). This pins
    // the RUNTIME half: an owner that cannot be resolved denies, and it denies
    // the instance admin too — "unknown owner, but you're an admin" is exactly
    // the operator-fallback being deleted.
    const session = makeSession()
    const ctl = control({ session, owner: undefined, machineUse: 'granted' })
    const admin = makeClient('c-admin', OWNER, 'admin')
    await ctl.onFrame(admin.principal, admin, { type: 'attach', sessionId: SESSION })
    expect(admin.sent).toContainEqual({
      type: 'terminalOutcome',
      sessionId: SESSION,
      outcome: 'unauthorized',
    })
    expect(session.terminal.clientCount).toBe(0)
  })

  it('denies DRIVE with an unresolvable owner, so requestControl cannot bypass attach', async () => {
    const session = makeSession()
    const ctl = control({ session, owner: undefined, machineUse: 'granted' })
    const admin = makeClient('c-admin2', OWNER, 'admin')
    expect(await ctl.authorizeDrive(admin.principal, SESSION)).toBe(false)
  })

  it('denies attach when the principal cannot see the session', async () => {
    const session = makeSession()
    const ctl = control({
      session,
      owner: { owner: OWNER, grants: [] }, // alice not on the list
      machineUse: 'granted',
    })
    const alice = makeClient('c-alice', ALICE, 'member')
    await ctl.onFrame(alice.principal, alice, { type: 'attach', sessionId: SESSION })
    expect(alice.sent).toContainEqual({
      type: 'terminalOutcome',
      sessionId: SESSION,
      outcome: 'unauthorized',
    })
    expect(session.terminal.clientCount).toBe(0)
  })

  it('denies attach when session is shared but machine use is refused', async () => {
    // THE back-door test: session grant alone must not open a PTY.
    const session = makeSession()
    const ctl = control({
      session,
      owner: { owner: OWNER, grants: [ALICE] },
      machineUse: 'denied',
    })
    const alice = makeClient('c-alice', ALICE, 'member')
    await ctl.onFrame(alice.principal, alice, { type: 'attach', sessionId: SESSION })
    expect(alice.sent).toContainEqual({
      type: 'terminalOutcome',
      sessionId: SESSION,
      outcome: 'unauthorized',
    })
    expect(session.terminal.clientCount).toBe(0)
  })

  it('returns a typed reason instead of attaching a Claude SDK Native view', async () => {
    const session = makeSession()
    session.driverId = 'claude-sdk'
    session.attachKinds = []
    const ctl = control({
      session,
      owner: { owner: OWNER, grants: [] },
      machineUse: 'granted',
    })
    const owner = makeClient('c-owner-native-gap', OWNER, 'admin')

    await ctl.onFrame(owner.principal, owner, { type: 'attach', sessionId: SESSION })

    expect(owner.sent).toContainEqual({
      type: 'terminalOutcome',
      sessionId: SESSION,
      outcome: 'unsupported',
      detail: "Runtime driver 'claude-sdk' does not support a Native view",
    })
    expect(owner.attached).not.toContain(SESSION)
    expect(session.terminal.clientCount).toBe(0)
  })

  it('allows attach for a grantee with machine use and stamps controller identity', async () => {
    const session = makeSession()
    const ctl = control({
      session,
      owner: { owner: OWNER, grants: [ALICE] },
      machineUse: 'granted',
    })
    const alice = makeClient('c-alice', ALICE, 'member')
    await ctl.onFrame(alice.principal, alice, { type: 'attach', sessionId: SESSION })
    expect(session.terminal.controllerId).toBe('c-alice')
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: ALICE })
    expect(alice.sent.some((m) => m.type === 'attached')).toBe(true)
  })

  it('refuses requestControl when the principal may only watch', async () => {
    const session = makeSession()
    // Owner attaches first and holds control.
    const owner = makeClient('c-owner', OWNER, 'admin')
    session.terminal.attachClient(owner)

    const ctl = control({
      session,
      // Alice can watch (on grants) but driveGrantees empty via authorizeDrive
      // which uses the same grants list for both — simulate read-only by denying
      // drive at the machine layer while still... actually authorizeDrive uses
      // the same grants for watch and drive when not split. Use a custom gate:
      owner: { owner: OWNER, grants: [] }, // alice not grantee → no drive
      machineUse: 'granted',
    })
    // Attach alice as spectator via direct terminal (already past attach gate).
    const alice = makeClient('c-alice', ALICE, 'member')
    session.terminal.attachClient(alice)
    alice.sent.length = 0

    await ctl.onFrame(alice.principal, alice, { type: 'requestControl', sessionId: SESSION })
    expect(alice.sent).toContainEqual({
      type: 'terminalOutcome',
      sessionId: SESSION,
      outcome: 'unauthorized',
    })
    expect(session.terminal.controllerId).toBe('c-owner')
  })

  it('preempts control for a drive-authorized grantee and broadcasts identity', async () => {
    const session = makeSession()
    const owner = makeClient('c-owner', OWNER, 'admin')
    session.terminal.attachClient(owner)

    const ctl = control({
      session,
      owner: { owner: OWNER, grants: [ALICE] },
      machineUse: 'granted',
    })
    const alice = makeClient('c-alice', ALICE, 'member')
    session.terminal.attachClient(alice)
    alice.viewVisible = new Set([SESSION])
    owner.sent.length = 0
    alice.sent.length = 0

    await ctl.onFrame(alice.principal, alice, {
      type: 'requestControl',
      sessionId: SESSION,
      geometry: { cols: 62, rows: 36 },
    })
    expect(session.terminal.controllerId).toBe('c-alice')
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: ALICE })
    expect(session.terminal.geometry).toEqual({ cols: 62, rows: 36 })
    expect(owner.sent).toContainEqual(
      expect.objectContaining({
        type: 'controllerChanged',
        controllerId: 'c-alice',
        controllerIdentity: { kind: 'user', user: ALICE },
      }),
    )
  })

  it('auto-controls only for the sole active native renderer, not a chat-only peer', async () => {
    const session = makeSession()
    const ctl = control({
      session,
      owner: { owner: OWNER, grants: [] },
      machineUse: 'granted',
    })
    const desktop = makeClient('c-desktop', OWNER, 'admin')
    const phone = makeClient('c-phone', OWNER, 'admin')
    await ctl.onFrame(desktop.principal, desktop, { type: 'attach', sessionId: SESSION })
    await ctl.onFrame(phone.principal, phone, { type: 'attach', sessionId: SESSION })

    await ctl.onFrame(desktop.principal, desktop, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'native' },
    })
    await ctl.onFrame(phone.principal, phone, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'native' },
    })
    expect(session.terminal.controllerId).toBe('c-desktop')
    phone.viewports.set(SESSION, { cols: 62, rows: 36 })

    // The same person's desktop remains in the session room but switches to
    // structured Chat. Only the phone consumes native geometry, so it becomes
    // controller automatically.
    await ctl.onFrame(desktop.principal, desktop, {
      type: 'viewState',
      visible: [SESSION],
      focused: SESSION,
      modes: { [SESSION]: 'chat' },
    })
    expect(session.terminal.controllerId).toBe('c-phone')
  })
})

describe('POD-1081 two-principal identity (not "the only connection")', () => {
  it('records the DRIVER principal, not merely the first or only socket', async () => {
    // Vacuity trap: a fixture with one principal cannot tell "records driver"
    // from "records the only connection" (POD-1424 class). Two distinct users.
    const session = makeSession()
    const ctl = control({
      session,
      owner: { owner: OWNER, grants: [ALICE] },
      machineUse: 'granted',
    })
    const owner = makeClient('c-owner', OWNER, 'admin')
    const alice = makeClient('c-alice', ALICE, 'member')

    await ctl.onFrame(owner.principal, owner, { type: 'attach', sessionId: SESSION })
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: OWNER })

    // Alice attaches as spectator — still owner's identity.
    await ctl.onFrame(alice.principal, alice, { type: 'attach', sessionId: SESSION })
    expect(session.terminal.controllerId).toBe('c-owner')
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: OWNER })

    // Alice takes control — identity MUST flip to alice, not stay owner.
    owner.sent.length = 0
    alice.sent.length = 0
    await ctl.onFrame(alice.principal, alice, { type: 'requestControl', sessionId: SESSION })
    expect(session.terminal.controllerId).toBe('c-alice')
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: ALICE })
    // Current driver observes the transfer (not a silent takeover).
    expect(owner.sent).toContainEqual(
      expect.objectContaining({
        type: 'controllerChanged',
        controllerId: 'c-alice',
        controllerIdentity: { kind: 'user', user: ALICE },
      }),
    )
  })

  it('two authorized claimants: second preemption wins; first observes controllerChanged', async () => {
    // THE policy content is what happens with TWO claimants, not one.
    const session = makeSession()
    const ctl = control({
      session,
      owner: { owner: OWNER, grants: [ALICE] },
      machineUse: 'granted',
    })
    const owner = makeClient('c-owner', OWNER, 'admin')
    const alice = makeClient('c-alice', ALICE, 'member')
    await ctl.onFrame(owner.principal, owner, { type: 'attach', sessionId: SESSION })
    await ctl.onFrame(alice.principal, alice, { type: 'attach', sessionId: SESSION })

    // Race: both request control. Last apply wins (preemption); both see the outcome.
    owner.sent.length = 0
    alice.sent.length = 0
    await ctl.onFrame(alice.principal, alice, { type: 'requestControl', sessionId: SESSION })
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: ALICE })
    await ctl.onFrame(owner.principal, owner, { type: 'requestControl', sessionId: SESSION })
    expect(session.terminal.controllerId).toBe('c-owner')
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: OWNER })
    // Alice (previous driver) observed the reclamation.
    expect(alice.sent).toContainEqual(
      expect.objectContaining({
        type: 'controllerChanged',
        controllerId: 'c-owner',
        controllerIdentity: { kind: 'user', user: OWNER },
      }),
    )
  })

  it('payload attribution is inert — transport principal wins (ADR 3 D7)', async () => {
    const session = makeSession()
    const owner = makeClient('c-owner', OWNER, 'admin')
    session.terminal.attachClient(owner)

    const handleControllerInputBytes = vi.fn(
      (principal: ClientPrincipal, client: ClientConn, sessionId: SessionId, bytes: Uint8Array) => {
        // Production SessionInbox stamps from principal, never from a frame field.
        session.terminal.handleInputBytes(client.id, bytes, {
          actor: { kind: 'user', id: principal.user },
          onBehalfOf: principal.user,
        })
      },
    )
    const ctl = new SessionClientControl({
      sessions: new Map([[SESSION, session]]),
      state: { replayDrafts: vi.fn(), handleDraftEdit: vi.fn() } as never,
      inbox: {
        handleControllerInputBytes,
        requestControl: vi.fn(),
        reconcileActiveRenderer: vi.fn(),
        handleResize: vi.fn(),
        reconcileGeometry: vi.fn(),
      } as unknown as SessionInbox,
      machinesForPrincipal: async () => [],
      browserOpen: { submitCallback: vi.fn(), dismiss: vi.fn() } as never,
      mutate: (_id, change) => change(session),
      broadcastSessions: vi.fn(),
      pushPriorities: vi.fn(),
      setDraft: vi.fn(),
      editDraft: vi.fn(),
      sessionOwner: async () => ({ owner: OWNER, grants: [] }),
      machineUseFor: async () => 'granted',
    })

    // Forged payload half — must never reach the inbox as a fifth argument.
    await ctl.onFrame(owner.principal, owner, {
      type: 'input',
      sessionId: SESSION,
      data: 'eA==',
      attribution: {
        actor: { kind: 'user', id: ALICE },
        onBehalfOf: ALICE,
      },
    } as never)

    expect(handleControllerInputBytes).toHaveBeenCalledTimes(1)
    expect(handleControllerInputBytes).toHaveBeenCalledWith(
      owner.principal,
      owner,
      SESSION,
      Buffer.from('eA==', 'base64'),
    )
    // Exactly four args — forged attribution is not threaded.
    expect(handleControllerInputBytes.mock.calls[0]).toHaveLength(4)
    expect(session.terminal.lastInputAttribution).toEqual({
      actor: { kind: 'user', id: OWNER },
      onBehalfOf: OWNER,
    })
    expect(session.terminal.lastInputAttribution?.onBehalfOf).not.toBe(ALICE)
  })

  it('identity survives connection reassign (reattach of the same principal)', () => {
    const session = makeSession()
    const first = makeClient('c-old', OWNER, 'admin')
    session.terminal.attachClient(first)
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: OWNER })
    // Production reclaim: new socket attaches, then reassignController maps the
    // old controller id onto the new connection. Identity remains the person.
    const next = makeClient('c-new', OWNER, 'admin')
    session.terminal.attachClient(next)
    session.terminal.reassignController('c-old', 'c-new')
    expect(session.terminal.controllerId).toBe('c-new')
    expect(session.terminal.controllerIdentity).toEqual({ kind: 'user', user: OWNER })
  })
})

describe('POD-1081 agent control drops at next apply (no reaper)', () => {
  it('revokes control when a previously-authorized principal applies after rights loss', async () => {
    const session = makeSession()
    const owner = makeClient('c-owner', OWNER, 'admin')
    session.terminal.attachClient(owner)
    expect(session.terminal.controllerId).toBe('c-owner')

    // Simulate rights revocation: authorizeDrive starts returning false.
    let allowed = true
    const inbox = {
      handleControllerInputBytes: (
        principal: ClientPrincipal,
        client: ClientConn,
        sessionId: SessionId,
        bytes: Uint8Array,
      ) => {
        if (!allowed) {
          if (session.terminal.controllerId === client.id) session.terminal.revokeController()
          return
        }
        session.terminal.handleInputBytes(client.id, bytes, {
          actor: { kind: 'user', id: principal.user },
          onBehalfOf: principal.user,
        })
      },
      requestControl: vi.fn(),
      reconcileActiveRenderer: vi.fn(),
      handleResize: vi.fn(),
      reconcileGeometry: vi.fn(),
    } as unknown as SessionInbox

    const ctl = new SessionClientControl({
      sessions: new Map([[SESSION, session]]),
      state: { replayDrafts: vi.fn(), handleDraftEdit: vi.fn() } as never,
      inbox,
      machinesForPrincipal: async () => [],
      browserOpen: { submitCallback: vi.fn(), dismiss: vi.fn() } as never,
      mutate: (_id, change) => change(session),
      broadcastSessions: vi.fn(),
      pushPriorities: vi.fn(),
      setDraft: vi.fn(),
      editDraft: vi.fn(),
      // Stated, not defaulted (POD-333): this case is about input attribution
      // after a revoke, so it grants both — but it has to SAY so.
      sessionOwner: async () => ({ owner: OWNER, grants: [] }),
      machineUseFor: async () => 'granted',
    })

    // Still authorized — input lands.
    await ctl.onFrame(owner.principal, owner, {
      type: 'input',
      sessionId: SESSION,
      data: 'eA==',
    })
    expect(session.terminal.lastInputAttribution).not.toBeNull()

    // Rights revoked. Next apply drops control with no reaper.
    allowed = false
    owner.sent.length = 0
    await ctl.onFrame(owner.principal, owner, {
      type: 'input',
      sessionId: SESSION,
      data: 'eA==',
    })
    expect(session.terminal.controllerId).toBeNull()
    expect(session.terminal.controllerIdentity).toBeNull()
    expect(owner.sent).toContainEqual(
      expect.objectContaining({ type: 'controllerChanged', controllerId: null }),
    )
  })
})

it('attaches, transfers control, and delivers input through the real async ownership wiring', async () => {
  const { SessionRegistry } = await import('../../relay')
  const { attachTestClient } = await import('../../test-support/client-transport')
  const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  const daemon: import('@podium/protocol/daemon').ControlMessage[] = []
  try {
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (message) => daemon.push(message))
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/tmp',
    })
    const first: ServerMessage[] = []
    const second: ServerMessage[] = []
    const firstId = attachTestClient(reg.clientGateway, (message) => first.push(message))
    const secondId = attachTestClient(reg.clientGateway, (message) => second.push(message))
    await reg.clientGateway.routeClientFrame(firstId, { type: 'attach', sessionId })
    expect(first).toContainEqual(
      expect.objectContaining({ type: 'attached', sessionId, controllerId: firstId }),
    )
    await reg.clientGateway.routeClientFrame(secondId, { type: 'attach', sessionId })
    await reg.clientGateway.routeClientFrame(secondId, { type: 'requestControl', sessionId })
    daemon.length = 0
    await reg.clientGateway.routeClientFrame(secondId, {
      type: 'input',
      sessionId,
      data: Buffer.from('echo ready\r').toString('base64'),
    })
    expect(daemon).toContainEqual(
      expect.objectContaining({
        type: 'input',
        sessionId,
        data: Buffer.from('echo ready\r').toString('base64'),
      }),
    )
    expect([...first, ...second]).not.toContainEqual(
      expect.objectContaining({ type: 'terminalOutcome', outcome: 'unauthorized' }),
    )
  } finally {
    reg.dispose()
  }
})

/**
 * MU-07/08 — THE PRIVATE-EXECUTION BOUNDARY (B1, PDM-133).
 *
 * "Alice owns task, Bob owns agent; Alice cannot view/control/resume Bob's run."
 *
 * THE FIXTURE IS DELIBERATELY `role: 'member'` ON BOTH SIDES, and that is
 * load-bearing rather than incidental. The helpers in this file default to
 * admin, so a cross-user case written the easy way used to be decided by
 * `humanMay`'s `role === 'admin'` break-glass and not by the ownership policy it
 * claims to exercise. That is catalogue entry 14, and PDM-250 shipped exactly
 * that defect: seven isolation tests passing while checking nothing.
 *
 * THAT BREAK-GLASS IS GONE as of PDM-270 — it contradicted the accepted D7, an
 * admin may not view or drive another member's session — so these cases no
 * longer have a second branch to fall through. The member fixture stays anyway:
 * it states the variable under test, and the admin case is now its own witness
 * directly below rather than a hazard to route around.
 */
describe('MU-07/08: a session is private to the human who started it', () => {
  const BOB = asUserId('user:bob')
  /** Bob's session, on a machine both can use. Ownership is the only variable. */
  const bobsOwnership = { owner: BOB, grants: [] }

  const memberClient = (id: string, user: UserId) => makeClient(id, user, 'member')

  it('refuses ATTACH to a human who does not own the session', async () => {
    const session = makeSession()
    const ctl = control({ session, owner: bobsOwnership, machineUse: 'granted' })
    const alice = memberClient('c-alice', ALICE)

    await ctl.onFrame(alice.principal, alice, { type: 'attach', sessionId: SESSION })

    expect(alice.sent).toContainEqual({
      type: 'terminalOutcome',
      sessionId: SESSION,
      outcome: 'unauthorized',
    })
    expect(alice.attached.has(SESSION)).toBe(false)
  })

  it('refuses DRIVE to a human who does not own the session', async () => {
    const session = makeSession()
    const ctl = control({ session, owner: bobsOwnership, machineUse: 'granted' })
    const alice = memberClient('c-alice-drive', ALICE)

    expect(await ctl.authorizeDrive(alice.principal, SESSION)).toBe(false)
  })

  /**
   * THE SAME REFUSAL FOR AN INSTANCE ADMIN, THROUGH THE REAL CONTROL PATH
   * [PDM-270]. The pure policy is covered in session-control-policy.test.ts; this
   * is the transport witness, because a rule that only a unit test sees is a rule
   * the next refactor deletes under a green suite (catalogue entry 20).
   *
   * Alice is `role: 'admin'` here — the one case the fixture above deliberately
   * avoids. Until PDM-270 both assertions answered the other way, and they are
   * the only two in this file that would.
   */
  it('refuses ATTACH and DRIVE to an instance ADMIN who does not own the session', async () => {
    const session = makeSession()
    const ctl = control({ session, owner: bobsOwnership, machineUse: 'granted' })
    const admin = makeClient('c-alice-admin', ALICE, 'admin')

    await ctl.onFrame(admin.principal, admin, { type: 'attach', sessionId: SESSION })

    expect(admin.sent).toContainEqual({
      type: 'terminalOutcome',
      sessionId: SESSION,
      outcome: 'unauthorized',
    })
    expect(admin.attached.has(SESSION)).toBe(false)
    expect(await ctl.authorizeDrive(admin.principal, SESSION)).toBe(false)
  })

  it('and admits that same ADMIN to the session it DOES own', async () => {
    // THE ALLOW ARM. The grade is not blacklisted; it is simply not consulted.
    const session = makeSession()
    const ctl = control({ session, owner: { owner: ALICE, grants: [] }, machineUse: 'granted' })
    const admin = makeClient('c-alice-admin-own', ALICE, 'admin')

    await ctl.onFrame(admin.principal, admin, { type: 'attach', sessionId: SESSION })

    expect(admin.attached.has(SESSION)).toBe(true)
    expect(await ctl.authorizeDrive(admin.principal, SESSION)).toBe(true)
  })

  it('refuses TRANSCRIPT SUBSCRIPTION to a human who does not own the session', async () => {
    // This frame had no authorization check of any kind before B1: it streamed
    // another human's transcript to any connected client that named the id,
    // while `attach` and `sessions.transcriptRead` both checked first.
    const session = makeSession()
    const subscribe = vi.spyOn(session.terminal, 'subscribeTranscript')
    const ctl = control({ session, owner: bobsOwnership, machineUse: 'granted' })
    const alice = memberClient('c-alice-transcript', ALICE)

    await ctl.onFrame(alice.principal, alice, {
      type: 'transcriptSubscribe',
      sessionId: SESSION,
    })

    expect(subscribe).not.toHaveBeenCalled()
    expect(alice.transcriptSubs.has(SESSION)).toBe(false)
  })

  it('refuses REDRAW to a human who does not own the session', async () => {
    const session = makeSession()
    const redraw = vi.spyOn(session.terminal, 'redraw')
    const ctl = control({ session, owner: bobsOwnership, machineUse: 'granted' })
    const alice = memberClient('c-alice-redraw', ALICE)

    await ctl.onFrame(alice.principal, alice, { type: 'redrawRequest', sessionId: SESSION })

    expect(redraw).not.toHaveBeenCalled()
  })

  /**
   * EVERY REFUSAL ABOVE PROVES IT CAN SAY YES FIRST. Four `not.toHaveBeenCalled`
   * / `false` assertions are exactly what a broken instrument reports, so the
   * owner runs the same four frames through the same fixture and is admitted.
   * Without this, a typo in the frame name would pass all four.
   */
  it('admits the OWNER through all four of the same paths', async () => {
    const session = makeSession()
    const subscribe = vi.spyOn(session.terminal, 'subscribeTranscript')
    const redraw = vi.spyOn(session.terminal, 'redraw')
    const ctl = control({ session, owner: bobsOwnership, machineUse: 'granted' })
    const bob = memberClient('c-bob', BOB)

    await ctl.onFrame(bob.principal, bob, { type: 'attach', sessionId: SESSION })
    await ctl.onFrame(bob.principal, bob, { type: 'transcriptSubscribe', sessionId: SESSION })
    await ctl.onFrame(bob.principal, bob, { type: 'redrawRequest', sessionId: SESSION })

    expect(bob.sent).not.toContainEqual(
      expect.objectContaining({ type: 'terminalOutcome', outcome: 'unauthorized' }),
    )
    expect(bob.attached.has(SESSION)).toBe(true)
    expect(bob.transcriptSubs.has(SESSION)).toBe(true)
    expect(subscribe).toHaveBeenCalled()
    expect(redraw).toHaveBeenCalled()
    expect(await ctl.authorizeDrive(bob.principal, SESSION)).toBe(true)
  })

  /**
   * THE CASE THIS CHANGE IS NOT ABOUT (catalogue entry 10): owning the session
   * is necessary but not sufficient — the machine gate is independent and still
   * refuses. Session ownership must not have become a back door to a host the
   * principal cannot use.
   */
  it('still refuses the OWNER to ATTACH when machine use is denied — but not to READ', async () => {
    const session = makeSession()
    const subscribe = vi.spyOn(session.terminal, 'subscribeTranscript')
    const ctl = control({ session, owner: bobsOwnership, machineUse: 'denied' })
    const bob = memberClient('c-bob-nomachine', BOB)

    await ctl.onFrame(bob.principal, bob, { type: 'attach', sessionId: SESSION })

    expect(bob.sent).toContainEqual({
      type: 'terminalOutcome',
      sessionId: SESSION,
      outcome: 'unauthorized',
    })
    expect(await ctl.authorizeDrive(bob.principal, SESSION)).toBe(false)

    /**
     * AND THE TWO GATES ARE ACTUALLY DIFFERENT. Opening a PTY is code execution
     * on that host and needs machine `use` (ADR 9 D6 M2); reading bytes the
     * session already produced is not, and its RPC sibling
     * `sessions.transcriptRead` has never asked for machine use either.
     *
     * This assertion is what makes `authorizeRead` a distinct thing rather than
     * a second spelling of `authorizeAttach` — route the transcript frame
     * through `authorizeAttach` instead and this line fails, while every other
     * assertion in this file stays green.
     */
    await ctl.onFrame(bob.principal, bob, { type: 'transcriptSubscribe', sessionId: SESSION })
    expect(subscribe).toHaveBeenCalled()
    expect(bob.transcriptSubs.has(SESSION)).toBe(true)
  })
})
