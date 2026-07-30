/**
 * THE GATEWAY END, THROUGH THE REAL SOCKET PATH. `wsServer.daemon.test.ts` already
 * pins today's daemon behaviour and still passes unchanged over the new framing;
 * this file adds what the framing brought: order enforcement on a live connection,
 * the envelope hello beside the legacy frames, payload-inert identity at the real
 * `MachinesService`, and the machine principal's owner-less fail-closed posture.
 */

import { createHash } from 'node:crypto'
import { machineUseAllowed, WIRE_VERSION } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { PairingManager } from '../hub/pairing'
import { SessionRegistry } from '../relay'
import { SessionStore } from '../store'
import { wireDaemonSocket } from '../wsServer'
import { createMachineDirectory } from './machine-directory'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

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

const registryWithMachine = (id = 'm1', token = 'tok') => {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id, name: 'box', hostname: 'box', tokenHash: sha256(token) })
  return new SessionRegistry(store)
}

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
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ kind: 'machine', machine: 'm1' }), expect.any(Function))
    // The envelope peer gets the envelope reply, and it names the id the SERVER
    // resolved rather than anything the peer claimed.
    const reply = ws.sent.map((s) => JSON.parse(s) as { type: string; assignedId?: string })
    expect(reply[0]).toMatchObject({ type: 'peerHelloOk', assignedId: 'm1' })
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
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ kind: 'machine', machine: 'm1' }), expect.any(Function))
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
    ws.emit('message', frame({ type: 'agentExit', sessionId: 's1', code: 0 }))
    expect(onMsg).toHaveBeenCalledWith(expect.objectContaining({ kind: 'machine', machine: 'm1' }), expect.objectContaining({ type: 'agentExit' }))
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
    const reg = new SessionRegistry(store, undefined, { pairing })
    const code = pairing.mint({})
    const directory = createMachineDirectory(reg.modules.machines)
    const paired = directory.redeemPairCode(code, {
      machineId: 'm-new',
      name: 'New Box',
      hostname: 'new.local',
    })
    expect(paired).toMatchObject({ machine: 'm-new', name: 'New Box' })
    expect(paired?.issuedToken).toBeTruthy()
    // Single use.
    expect(directory.redeemPairCode(code, { machineId: 'm-new' })).toBeNull()
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
