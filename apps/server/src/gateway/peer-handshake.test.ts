/**
 * THE GATEWAY END, THROUGH THE REAL SOCKET PATH. `wsServer.daemon.test.ts` already
 * pins today's daemon behaviour and still passes unchanged over the new framing;
 * this file adds what the framing brought: order enforcement on a live connection,
 * the envelope hello beside the legacy frames, payload-inert identity at the real
 * `MachinesService`, and the machine principal's owner-less fail-closed posture.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId, asMachineId, asSessionId } from '@podium/model'
import { machineUseAllowed, WIRE_VERSION } from '@podium/protocol'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mintPairingToken, openEnrollmentLedger } from '../enrollment-ledger'
import { PairingManager } from '../hub/pairing'
import { MachinesService } from '../modules/machines/service'
import { SessionRegistry } from '../relay'
import { SessionStore } from '../store'
import { wireDaemonSocket } from './daemon-socket'
import { createMachineDirectory } from './machine-directory'
import { createDaemonAcceptor, receiveDaemonFrame } from './peer-handshake'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const handshakeTmpDirs: string[] = []
const handshakeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-verify-only-'))
  handshakeTmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of handshakeTmpDirs) rmSync(dir, { recursive: true, force: true })
})

function fakeWs() {
  const sent: string[] = []
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  return {
    sent,
    readyState: 1,
    bufferedAmount: 0,
    send: (s: string) => sent.push(s),
    terminate: () => {},
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      ;(handlers[ev] ??= []).push(cb)
    },
    emit: (ev: string, ...a: unknown[]) => {
      for (const handler of handlers[ev] ?? []) handler(...a)
    },
  }
}

const registryWithMachine = (id = 'm1', token = 'tok', updatePubkey?: string) => {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({
    id,
    name: 'box',
    hostname: 'box',
    tokenHash: sha256(token),
    ownerUserId: asUserId('user:sole'),
  })
  return new SessionRegistry(store, undefined, {
    instanceId: 'default',
    ...(updatePubkey === undefined ? {} : { updatePubkey: () => updatePubkey }),
  })
}

interface EnrollmentHandshakeWorldOptions {
  readonly queryOnly?: boolean
  readonly row?: boolean
  readonly revoked?: boolean
}

const enrollmentHandshakeWorld = (options: EnrollmentHandshakeWorldOptions = {}) => {
  const stateRoot = handshakeTmp()
  const dbPath = join(stateRoot, 'podium.db')
  const seeded = new SessionStore(dbPath)
  const hostMachineId = seeded.hostMachineId
  const machineId = asMachineId('remote-machine')
  const enrollment = openEnrollmentLedger(stateRoot)
  const token = mintPairingToken(enrollment.pairingRoot, { machineId, serial: 1 })
  enrollment.appendEnroll({
    id: 'enroll-remote',
    machineId,
    serial: 1,
    ownerUserId: asUserId('user:sole'),
    at: '2026-08-18T00:00:00.000Z',
  })
  if (options.revoked) {
    enrollment.appendRevoke({
      id: 'revoke-remote',
      machineId,
      serial: 1,
      by: null,
      at: '2026-08-18T00:01:00.000Z',
    })
  }
  if (options.row !== false) {
    seeded.machines.upsertMachine({
      id: machineId,
      name: 'Durable machine',
      hostname: 'stored.local',
      tokenHash: sha256(token),
      ownerUserId: asUserId('user:sole'),
    })
  }
  seeded.close()

  const store = new SessionStore(dbPath, hostMachineId, {
    queryOnly: options.queryOnly ?? true,
  })
  const pairing = new PairingManager()
  const machines = new MachinesService({
    instanceId: 'verify-only-test',
    store,
    hostMachineId,
    pairing,
    enrollment,
    userExists: (id) => store.users.get(id) !== undefined,
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: () => [],
  })
  return { dbPath, enrollment, hostMachineId, machineId, machines, pairing, store, token }
}

const receiveHello = (
  machines: MachinesService,
  machineId: string,
  token: string,
  verifyOnly: boolean,
) =>
  receiveDaemonFrame(
    createDaemonAcceptor({ machines, connectionId: 'verify-only-test', verifyOnly }),
    JSON.stringify({ type: 'hello', machineId, token, hostname: 'observed.local' }),
  )

const frame = (o: unknown) => Buffer.from(JSON.stringify(o))

describe('the daemon socket speaks the permanent envelope', () => {
  it('authenticates an envelope hello carrying a machine token', () => {
    const reg = registryWithMachine()
    const attach = vi.spyOn(reg.gateway, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit(
      'message',
      frame({
        type: 'peerHello',
        v: WIRE_VERSION,
        caps: [],
        credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
        claims: { hostname: 'box' },
      }),
    )
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'machine', machine: 'm1' }),
      expect.any(Function),
    )
    // The envelope peer gets the envelope reply, and it names the id the SERVER
    // resolved rather than anything the peer claimed.
    const reply = ws.sent.map((s) => JSON.parse(s) as { type: string; assignedId?: string })
    expect(reply[0]).toMatchObject({ type: 'peerHelloOk', assignedId: 'm1' })
  })

  it('publishes the current server key on an ordinary reconnect', () => {
    const reg = registryWithMachine('m1', 'tok', 'server-key-1')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit(
      'message',
      frame({
        type: 'peerHello',
        v: WIRE_VERSION,
        caps: [],
        credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
        claims: { hostname: 'box' },
      }),
    )
    expect(JSON.parse(ws.sent[0] ?? '{}')).toMatchObject({
      type: 'peerHelloOk',
      updatePubkey: 'server-key-1',
    })
  })

  it('refuses an envelope hello on an unsupported wire version, before auth', () => {
    const reg = registryWithMachine()
    const attach = vi.spyOn(reg.gateway, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit(
      'message',
      frame({
        type: 'peerHello',
        v: WIRE_VERSION + 9,
        caps: [],
        credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
      }),
    )
    expect(attach).not.toHaveBeenCalled()
    expect(ws.sent.map((s) => JSON.parse(s) as { reason?: string })[0]).toMatchObject({
      reason: 'unsupported-version',
    })
  })

  it('ignores reserved node capabilities without granting anything (ADR 5 D4.4)', () => {
    const reg = registryWithMachine()
    const attach = vi.spyOn(reg.gateway, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit(
      'message',
      frame({
        type: 'peerHello',
        v: WIRE_VERSION,
        caps: ['peerRole:node', 'upstream.push', 'feed.f1'],
        feedId: 'feed-f1',
        credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
      }),
    )
    // Attached as an ordinary machine; no elevation, and no accepted caps.
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'machine', machine: 'm1' }),
      expect.any(Function),
    )
    expect(JSON.parse(ws.sent[0] ?? '{}')).toMatchObject({ type: 'peerHelloOk', caps: [] })
  })
})

describe('handshake order at the real gateway', () => {
  it('refuses a second handshake on a live connection instead of re-authenticating', () => {
    const reg = registryWithMachine()
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'box' }))
    expect(ws.sent.some((s) => s.includes('helloOk'))).toBe(true)

    const before = ws.sent.length
    ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'box' }))
    const after = ws.sent.slice(before).map((s) => JSON.parse(s) as { type: string })
    // A rejection, not a second helloOk — a live connection's principal is fixed.
    expect(after.some((m) => m.type === 'helloRejected')).toBe(true)
  })

  it('a rejected socket stays rejected: the peer cannot retry into an attach', () => {
    const reg = registryWithMachine()
    const attach = vi.spyOn(reg.gateway, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    // Wrong token first …
    ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'nope', hostname: 'box' }))
    expect(ws.sent.some((s) => s.includes('helloRejected'))).toBe(true)
    // … then the right one on the SAME socket. The daemon treats a rejection as
    // terminal (daemon.ts blocks, no reconnect loop) and so does the gateway.
    ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'box' }))
    expect(attach).not.toHaveBeenCalled()
  })

  it('still routes ordinary control traffic after the handshake', () => {
    const reg = registryWithMachine()
    const onMsg = vi.spyOn(reg.gateway, 'routeDaemonFrame').mockImplementation(() => {})
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'box' }))
    ws.emit('message', frame({ type: 'agentExit', sessionId: asSessionId('s1'), code: 0 }))
    expect(onMsg).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'machine', machine: 'm1' }),
      expect.objectContaining({ type: 'agentExit' }),
    )
  })
})

describe('recovery-only daemon handshake verification', () => {
  it('accepts an existing unrevoked token without touching or invalidating its row', () => {
    const world = enrollmentHandshakeWorld()
    const touch = vi.spyOn(world.store.machines, 'touchMachine')
    const invalidate = vi.spyOn(world.machines, 'invalidateMachineCache')
    try {
      expect(receiveHello(world.machines, world.machineId, world.token, true)).toMatchObject({
        kind: 'established',
        machineId: world.machineId,
        name: 'Durable machine',
      })
      expect(touch).not.toHaveBeenCalled()
      expect(invalidate).not.toHaveBeenCalled()
      expect(world.store.machines.getMachine(world.machineId)?.hostname).toBe('stored.local')
    } finally {
      world.store.close()
    }
  })

  it.each([
    {
      verdict: 'revoked token',
      setup: () => {
        const world = enrollmentHandshakeWorld({ revoked: true })
        return { world, token: world.token }
      },
    },
    {
      verdict: 'invalid token',
      setup: () => {
        const world = enrollmentHandshakeWorld()
        return { world, token: 'invalid-token' }
      },
    },
    {
      verdict: 'missing row',
      setup: () => {
        const world = enrollmentHandshakeWorld({ row: false })
        return { world, token: world.token }
      },
    },
  ])('rejects a $verdict without writing', ({ setup }) => {
    const { world, token } = setup()
    const touch = vi.spyOn(world.store.machines, 'touchMachine')
    try {
      expect(receiveHello(world.machines, world.machineId, token, true).kind).toBe('rejected')
      expect(touch).not.toHaveBeenCalled()
    } finally {
      world.store.close()
    }
  })

  it('rejects pairing before consuming its code', () => {
    const world = enrollmentHandshakeWorld({ queryOnly: false })
    const code = world.machines.mintPairingCode({ ownerUserId: asUserId('user:sole') })
    const machineId = asMachineId('new-machine')
    try {
      const outcome = receiveDaemonFrame(
        createDaemonAcceptor({
          machines: world.machines,
          connectionId: 'verify-only-pair',
          verifyOnly: true,
        }),
        JSON.stringify({ type: 'pair', code, machineId, hostname: 'new.local' }),
      )
      expect(outcome.kind).toBe('rejected')
      expect(world.store.machines.getMachine(machineId)).toBeUndefined()
      expect(
        world.machines.authenticateDaemon({
          type: 'pair',
          code,
          machineId,
          hostname: 'new.local',
        }),
      ).toMatchObject({ ok: true, machineId })
    } finally {
      world.store.close()
    }
  })

  it('keeps ordinary handshake touch and cache invalidation', () => {
    const world = enrollmentHandshakeWorld({ queryOnly: false })
    const touch = vi.spyOn(world.store.machines, 'touchMachine')
    const invalidate = vi.spyOn(world.machines, 'invalidateMachineCache')
    try {
      expect(receiveHello(world.machines, world.machineId, world.token, false).kind).toBe(
        'established',
      )
      expect(touch).toHaveBeenCalledWith(world.machineId, 'observed.local')
      expect(invalidate).toHaveBeenCalledOnce()
      expect(world.store.machines.getMachine(world.machineId)?.hostname).toBe('observed.local')
    } finally {
      world.store.close()
    }
  })
})

describe('payload identity is inert at the real MachinesService', () => {
  it('a valid token presented under another machine id is refused, not rebound', () => {
    const reg = registryWithMachine('m1', 'tok')
    reg.modules.machines.listMachines() // warm the cache; irrelevant to the assertion
    const attach = vi.spyOn(reg.gateway, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'm-someone-elses', token: 'tok', hostname: 'evil' }),
    )
    expect(attach).not.toHaveBeenCalled()
    expect(ws.sent.some((s) => s.includes('helloRejected'))).toBe(true)
  })

  it('a token with no machine hint fails closed rather than scanning', () => {
    const reg = registryWithMachine()
    const directory = createMachineDirectory(reg.modules.machines)
    expect(directory.verifyMachineToken('tok')).toBeNull()
  })

  it('pairing passes the peer name through and mints a token once', () => {
    const store = new SessionStore(':memory:')
    const pairing = new PairingManager()
    const reg = new SessionRegistry(store, undefined, {
      instanceId: 'default',
      pairing,
      updatePubkey: () => 'server-key-1',
    })
    const code = pairing.mint({})
    const directory = createMachineDirectory(reg.modules.machines)
    const paired = directory.redeemPairCode(code, {
      machineId: asMachineId('m-new'),
      name: 'New Box',
      hostname: 'new.local',
    })
    expect(paired).toMatchObject({ machine: 'm-new', name: 'New Box' })
    expect(paired).toMatchObject({ issuedToken: expect.any(String), updatePubkey: 'server-key-1' })
    // Single use.
    expect(directory.redeemPairCode(code, { machineId: asMachineId('m-new') })).toBeNull()
  })

  /**
   * POD-1125: a pair code is permission to ADD a machine, not to take over one.
   *
   * TWO existing machines are seeded so the fixture can fail in either direction:
   * without a second row, "refuses rebind" is vacuous (nothing to steal). One is
   * owned and one is unowned so a guard that only protects rows with an
   * ownerUserId still fails (that weaker guard was a silent mutant). The
   * attacker is a third principal. Measured quantities: exact refuse reason on
   * BOTH victims, both victim tokens still verify, neither row is renamed, and
   * the same code still admits a NEW machineId (allowance branch).
   */
  it('a pair code cannot rebind an existing machine id', () => {
    const store = new SessionStore(':memory:')
    store.machines.upsertMachine({
      id: 'admin-laptop',
      name: 'Admin Laptop',
      hostname: 'admin.local',
      tokenHash: sha256('admin-tok'),
      ownerUserId: asUserId('user:admin'),
    })
    // Unowned but still registered — existence, not ownership, is the rule.
    store.machines.upsertMachine({
      id: 'unowned-box',
      name: 'Unowned Box',
      hostname: 'unowned.local',
      tokenHash: sha256('unowned-tok'),
      ownerUserId: null,
    })
    const pairing = new PairingManager()
    const reg = new SessionRegistry(store, undefined, { instanceId: 'default', pairing })
    const machines = reg.modules.machines
    // Mint via the service so ownerUserId is stamped (hub PairingGrant is a narrower type).
    const code = machines.mintPairingCode({ ownerUserId: asUserId('user:attacker') })

    // SECOND machine (attacker) attempts rebind under admin-laptop's id.
    const attackOwned = machines.authenticateDaemon({
      type: 'pair',
      code,
      machineId: asMachineId('admin-laptop'),
      hostname: 'evil.local',
      name: 'Attacker Box',
    })
    expect(attackOwned).toEqual({ ok: false, reason: 'machine id already registered' })

    // Same code, second victim: unowned existing row must refuse too.
    const attackUnowned = machines.authenticateDaemon({
      type: 'pair',
      code,
      machineId: asMachineId('unowned-box'),
      hostname: 'evil.local',
      name: 'Attacker Box',
    })
    expect(attackUnowned).toEqual({ ok: false, reason: 'machine id already registered' })

    // Both pre-existing credentials still verify — rebind would kill their tokens.
    expect(
      machines.authenticateDaemon({
        type: 'hello',
        machineId: asMachineId('admin-laptop'),
        token: 'admin-tok',
        hostname: 'admin.local',
      }),
    ).toMatchObject({ ok: true, machineId: 'admin-laptop' })
    expect(
      machines.authenticateDaemon({
        type: 'hello',
        machineId: asMachineId('unowned-box'),
        token: 'unowned-tok',
        hostname: 'unowned.local',
      }),
    ).toMatchObject({ ok: true, machineId: 'unowned-box' })

    // Rows not renamed and ownership not transferred (null stays null).
    expect(store.machines.getMachine('admin-laptop')).toMatchObject({
      name: 'Admin Laptop',
      ownerUserId: 'user:admin',
    })
    expect(store.machines.getMachine('unowned-box')).toMatchObject({
      name: 'Unowned Box',
      ownerUserId: null,
    })

    // Collision refused BEFORE redeem, so the same code still admits a NEW id
    // (the allowance branch — without it the guard could be "refuse all pairs").
    const directory = createMachineDirectory(machines)
    const paired = directory.redeemPairCode(code, {
      machineId: asMachineId('attacker-fresh'),
      name: 'Attacker Box',
      hostname: 'evil.local',
    })
    expect(paired).toMatchObject({ machine: 'attacker-fresh', name: 'Attacker Box' })
    expect(paired?.issuedToken).toBeTruthy()
    expect(store.machines.getMachine('attacker-fresh')?.ownerUserId).toBe('user:attacker')
  })
})

describe('the machine principal carries owner and grants, and fails closed without them', () => {
  it('an existing machine row has no owner yet, so it grants `use` to nobody', () => {
    const reg = registryWithMachine()
    const directory = createMachineDirectory(reg.modules.machines)
    const resolved = directory.verifyMachineToken('tok', 'm1', { hostname: 'box' })
    expect(resolved).toMatchObject({ machine: 'm1', owner: null, grants: [] })
    // The all-in-one guard: authenticating to the server confers no execute on the
    // host machine, and an owner-less row confers it on nobody at all.
    expect(machineUseAllowed(resolved as NonNullable<typeof resolved>, null)).toBe(false)
  })
})
