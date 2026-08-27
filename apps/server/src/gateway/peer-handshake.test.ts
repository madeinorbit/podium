/**
 * THE GATEWAY END, THROUGH THE REAL SOCKET PATH. `wsServer.daemon.test.ts` already
 * pins today's daemon behaviour and still passes unchanged over the new framing;
 * this file adds what the framing brought: order enforcement on a live connection,
 * the envelope hello beside the legacy frames, payload-inert identity at the real
 * `MachinesService`, and the machine principal's owner-less fail-closed posture.
 */

import { createHash } from 'node:crypto'
import { asMachineId, asSessionId, asUserId } from '@podium/model'
import {
  BINARY_ENVELOPE_MAX_MESSAGE_BYTES,
  CAP_TERMINAL_INPUT_BINARY_V1,
  CAP_TERMINAL_OUTPUT_BINARY_V1,
  DaemonPtyInputMetadata,
  type DaemonPtyOutputMetadata,
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  machineUseAllowed,
  WIRE_VERSION,
} from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { PairingManager } from '../hub/pairing'
import { SessionRegistry } from '../relay'
import { SessionStore } from '../store'
import { wireDaemonSocket } from './daemon-socket'
import { createMachineDirectory } from './machine-directory'
import { createDaemonAcceptor, receiveDaemonFrame } from './peer-handshake'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

function fakeWs() {
  const binarySent: Uint8Array[] = []
  const sent: string[] = []
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  return {
    binarySent,
    sent,
    readyState: 1,
    bufferedAmount: 0,
    sendBinary: (bytes: Uint8Array) => binarySent.push(bytes.slice()),
    send: (s: string) => sent.push(s),
    terminate: vi.fn(),
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

const frame = (o: unknown): string => JSON.stringify(o)
const binaryFrame = (metadata: unknown, payload = new Uint8Array()): Buffer => {
  const metadataBytes = Buffer.from(JSON.stringify(metadata))
  const result = Buffer.alloc(4 + metadataBytes.byteLength + payload.byteLength)
  result.writeUInt32BE(metadataBytes.byteLength, 0)
  metadataBytes.copy(result, 4)
  result.set(payload, 4 + metadataBytes.byteLength)
  return result
}

const authenticatedSocket = (caps: string[]) => {
  const reg = registryWithMachine()
  const ws = fakeWs()
  wireDaemonSocket(ws as never, reg)
  ws.emit(
    'message',
    frame({
      type: 'peerHello',
      v: WIRE_VERSION,
      caps,
      credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
    }),
  )
  return { reg, ws }
}

describe('the daemon socket speaks the permanent envelope', () => {
  it('retains offered and actually accepted daemon capabilities separately', () => {
    const reg = registryWithMachine()
    const hello = (caps: string[]) =>
      frame({
        type: 'peerHello',
        v: WIRE_VERSION,
        caps,
        credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
      })
    const negotiated = receiveDaemonFrame(
      createDaemonAcceptor({
        machines: reg.modules.machines,
        connectionId: 'caps-negotiated',
      }),
      hello([CAP_TERMINAL_OUTPUT_BINARY_V1, 'future.daemon.cap']),
    )
    expect(negotiated).toMatchObject({
      kind: 'established',
      offeredCaps: [CAP_TERMINAL_OUTPUT_BINARY_V1, 'future.daemon.cap'],
      acceptedCaps: [CAP_TERMINAL_OUTPUT_BINARY_V1],
      reply: { caps: [CAP_TERMINAL_OUTPUT_BINARY_V1] },
    })

    const unoffered = receiveDaemonFrame(
      createDaemonAcceptor({
        machines: reg.modules.machines,
        connectionId: 'caps-unoffered',
      }),
      hello([]),
    )
    expect(unoffered).toMatchObject({
      kind: 'established',
      offeredCaps: [],
      acceptedCaps: [],
      reply: { caps: [] },
    })
  })

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
      expect.objectContaining({ send: expect.any(Function), sendInput: expect.any(Function) }),
    )
    // The envelope peer gets the envelope reply, and it names the id the SERVER
    // resolved rather than anything the peer claimed.
    const reply = ws.sent.map((s) => JSON.parse(s) as { type: string; assignedId?: string })
    expect(reply[0]).toMatchObject({ type: 'peerHelloOk', assignedId: 'm1' })
  })

  it('routes negotiated native binary output with exact bytes and source frames', () => {
    const reg = registryWithMachine()
    const route = vi.spyOn(reg.gateway, 'routeDaemonOutput').mockImplementation(() => {})
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit(
      'message',
      frame({
        type: 'peerHello',
        v: WIRE_VERSION,
        caps: [CAP_TERMINAL_OUTPUT_BINARY_V1],
        credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
      }),
    )
    const payload = Uint8Array.of(0x00, 0xff, 0xe2, 0x82, 0x1b)
    const metadata: DaemonPtyOutputMetadata = {
      v: 1,
      type: 'ptyOutput',
      sessionId: asSessionId('binary-session'),
      sourceFrames: 3,
    }
    const encoded = encodeBinaryEnvelope(metadata, payload)
    ws.emit('message', Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength))
    expect(route).toHaveBeenCalledOnce()
    const batch = route.mock.calls[0]![1]
    expect(batch).toMatchObject({ sessionId: 'binary-session', sourceFrames: 3 })
    expect(batch.bytes).toEqual(payload)
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('serves exact binary PTY input only after the daemon negotiates it', () => {
    const reg = registryWithMachine()
    const attach = vi.spyOn(reg.gateway, 'attachDaemon')
    const ws = fakeWs()
    wireDaemonSocket(ws as never, reg)
    ws.emit(
      'message',
      frame({
        type: 'peerHello',
        v: WIRE_VERSION,
        caps: [CAP_TERMINAL_INPUT_BINARY_V1],
        credential: { kind: 'machineToken', token: 'tok', machineHint: 'm1' },
      }),
    )
    const transport = attach.mock.calls[0]?.[1] as {
      sendInput(input: import('@podium/protocol').DaemonPtyInputBatch): void
    }
    const payload = Uint8Array.of(0, 0xff, 0x1b, 0x0d)
    transport.sendInput({ sessionId: asSessionId('s1'), inputOrigin: 'human', bytes: payload })
    expect(ws.binarySent).toHaveLength(1)
    const framed = ws.binarySent[0]
    expect(framed).toBeDefined()
    if (!framed) throw new Error('expected one binary PTY input frame')
    const decoded = decodeBinaryEnvelope(framed, DaemonPtyInputMetadata)
    expect(decoded.metadata).toMatchObject({
      sessionId: 's1',
      inputOrigin: 'human',
    })
    expect(decoded.payload).toEqual(payload)
    expect(ws.sent.filter((value) => value.includes('"type":"input"'))).toHaveLength(0)
  })

  it('terminates pre-auth binary locally while another daemon remains routable', () => {
    const reg = registryWithMachine()
    const route = vi.spyOn(reg.gateway, 'routeDaemonFrame').mockImplementation(() => {})
    const bad = fakeWs()
    const healthy = fakeWs()
    wireDaemonSocket(bad as never, reg)
    wireDaemonSocket(healthy as never, reg)
    bad.emit('message', Buffer.from([0, 0, 0, 0]))
    expect(bad.terminate).toHaveBeenCalledOnce()
    healthy.emit(
      'message',
      frame({
        type: 'hello',
        machineId: 'm1',
        token: 'tok',
        hostname: 'box',
      }),
    )
    healthy.emit('message', frame({ type: 'agentExit', sessionId: 'session-1', code: 0 }))
    expect(route).toHaveBeenCalledOnce()
    expect(healthy.terminate).not.toHaveBeenCalled()
  })

  it('terminates binary output after a handshake that did not negotiate it', () => {
    const { reg, ws } = authenticatedSocket([])
    const route = vi.spyOn(reg.gateway, 'routeDaemonFrame').mockImplementation(() => {})
    const binary = binaryFrame({ v: 1, type: 'ptyOutput', sessionId: 's1', sourceFrames: 1 })
    ws.emit('message', binary)
    ws.emit('message', frame({ type: 'agentExit', sessionId: 'session-1', code: 0 }))
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(route).not.toHaveBeenCalled()
  })

  it.each([
    ['truncated', Buffer.from([0, 0, 0])],
    ['wrong plane', binaryFrame({ v: 1, type: 'ptyOutput', sessionId: 's1', seq: 1, epoch: 0 })],
    [
      'unsupported version',
      binaryFrame({ v: 2, type: 'ptyOutput', sessionId: 's1', sourceFrames: 1 }),
    ],
    [
      'nonpositive source frames',
      binaryFrame({ v: 1, type: 'ptyOutput', sessionId: 's1', sourceFrames: 0 }),
    ],
    [
      'unsafe source frames',
      binaryFrame({
        v: 1,
        type: 'ptyOutput',
        sessionId: 's1',
        sourceFrames: Number.MAX_SAFE_INTEGER,
      }),
    ],
    ['oversized', Buffer.allocUnsafe(BINARY_ENVELOPE_MAX_MESSAGE_BYTES + 1)],
  ])('terminates negotiated %s binary output', (_name, binary) => {
    const { ws } = authenticatedSocket([CAP_TERMINAL_OUTPUT_BINARY_V1])
    ws.emit('message', binary)
    expect(ws.terminate).toHaveBeenCalledOnce()
  })

  it('keeps an old daemon on one canonical legacy decode', () => {
    const { reg, ws } = authenticatedSocket([])
    const routeOutput = vi.spyOn(reg.gateway, 'routeDaemonOutput').mockImplementation(() => {})
    const routeFrame = vi.spyOn(reg.gateway, 'routeDaemonFrame').mockImplementation(() => {})
    ws.emit(
      'message',
      frame({ type: 'agentFrameBatch', sessionId: 'legacy', frames: ['AP8=', ''] }),
    )
    expect(routeOutput).toHaveBeenCalledOnce()
    const batch = routeOutput.mock.calls[0]![1]
    expect(batch).toMatchObject({ sessionId: 'legacy', sourceFrames: 2 })
    expect(batch.bytes).toEqual(Uint8Array.of(0x00, 0xff))
    expect(routeFrame).not.toHaveBeenCalled()
    expect(ws.terminate).not.toHaveBeenCalled()
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
      expect.objectContaining({ send: expect.any(Function), sendInput: expect.any(Function) }),
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
