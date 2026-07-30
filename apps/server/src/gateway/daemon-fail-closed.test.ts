/**
 * FAIL CLOSED ON THE `/daemon` EDGE (POD-389 AC 7).
 *
 * An unpaired, unrecognised or REVOKED daemon is rejected — not admitted with
 * reduced trust — and a rejected socket stays rejected: nothing it says
 * afterwards reaches a feature port. The local daemon is checked against the
 * SAME bar as a remote one, because the all-in-one deployment (§3.1.4 M4) is the
 * sharpest case: when the server runs on someone's Mac the local daemon IS that
 * Mac, and `use` is a code-execution boundary.
 *
 * Every assertion here is a NEGATIVE one, so the suite opens by proving the
 * instrument can say YES: a good hello on the same fixture must attach and route.
 */

import { asSessionId } from '@podium/model'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../relay'
import { SessionStore } from '../store'
import { wireDaemonSocket } from './daemon-socket'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

function fakeWs() {
  const sent: string[] = []
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  return {
    sent,
    readyState: 1,
    send: (s: string) => sent.push(s),
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      ;(handlers[ev] ??= []).push(cb)
    },
    emit: (ev: string, ...a: unknown[]) => {
      for (const handler of handlers[ev] ?? []) handler(...a)
    },
  }
}

const frame = (v: unknown): Buffer => Buffer.from(JSON.stringify(v))

const A_ROUTABLE_FRAME = {
  type: 'bind',
  sessionId: asSessionId('s1'),
  cmd: 'claude',
  cwd: '/tmp',
  agentKind: 'claude-code',
  geometry: { cols: 80, rows: 24 },
}

/** A registry with `machines` rows and spies on the gateway's two entry points. */
function harness(machines: { id: string; token: string }[]) {
  const store = new SessionStore(':memory:')
  for (const m of machines) {
    store.machines.upsertMachine({
      id: m.id,
      name: m.id,
      hostname: m.id,
      tokenHash: sha256(m.token),
    })
  }
  const reg = new SessionRegistry(store)
  const attach = vi.spyOn(reg.gateway, 'attachDaemon')
  const route = vi.spyOn(reg.gateway, 'routeDaemonFrame').mockImplementation(() => {})
  const ws = fakeWs()
  wireDaemonSocket(ws as never, reg)
  return { store, reg, ws, attach, route }
}

describe('the instrument', () => {
  it('attaches and routes for a daemon that IS recognised', () => {
    // Without this, every refusal below could be a socket that routes nothing at
    // all — a refusal-only suite that would pass against a broken wiring.
    const h = harness([{ id: 'm1', token: 'tok' }])
    h.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'm1' }))
    expect(h.attach).toHaveBeenCalledTimes(1)
    h.ws.emit('message', frame(A_ROUTABLE_FRAME))
    expect(h.route).toHaveBeenCalledTimes(1)
  })
})

describe('a daemon that cannot prove who it is', () => {
  it('rejects an UNPAIRED machine and admits nothing', () => {
    const h = harness([])
    h.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'ghost', token: 'whatever', hostname: 'ghost' }),
    )
    expect(h.attach).not.toHaveBeenCalled()
    expect(h.ws.sent.some((s) => s.includes('helloRejected'))).toBe(true)
  })

  it('rejects a REVOKED credential — the machine row alone is not admission', () => {
    // Rotating the token is revocation of the old one. The machine still exists,
    // is still named, and is still in the fleet; a daemon holding the previous
    // secret must get nothing, not a degraded session.
    const h = harness([{ id: 'm1', token: 'old' }])
    h.store.machines.upsertMachine({
      id: 'm1',
      name: 'm1',
      hostname: 'm1',
      tokenHash: sha256('rotated'),
    })
    h.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'old', hostname: 'm1' }))
    expect(h.attach).not.toHaveBeenCalled()
    expect(h.ws.sent.some((s) => s.includes('helloRejected'))).toBe(true)
  })

  it('rejects a valid token presented under ANOTHER machine id, rather than rebinding', () => {
    const h = harness([
      { id: 'm1', token: 'tok1' },
      { id: 'm2', token: 'tok2' },
    ])
    h.ws.emit('message', frame({ type: 'hello', machineId: 'm2', token: 'tok1', hostname: 'm2' }))
    expect(h.attach).not.toHaveBeenCalled()
  })

  it('keeps a REJECTED socket rejected: later frames reach no feature port', () => {
    const h = harness([{ id: 'm1', token: 'tok' }])
    h.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'wrong', hostname: 'm1' }))
    expect(h.attach).not.toHaveBeenCalled()
    // A retry with the CORRECT token on the same socket must not succeed — a
    // socket that can retry into a usable connection is an oracle for guessing.
    h.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'm1' }))
    expect(h.attach).not.toHaveBeenCalled()
    // And application traffic never routes.
    h.ws.emit('message', frame(A_ROUTABLE_FRAME))
    expect(h.route).not.toHaveBeenCalled()
  })

  it('drops pre-auth application traffic without creating a principal', () => {
    const h = harness([{ id: 'm1', token: 'tok' }])
    h.ws.emit('message', frame(A_ROUTABLE_FRAME))
    expect(h.route).not.toHaveBeenCalled()
    expect(h.attach).not.toHaveBeenCalled()
    // Closing an unattached socket must not detach a machine that may have a
    // healthy daemon on another socket.
    const detach = vi.spyOn(h.reg.gateway, 'detachDaemon')
    h.ws.emit('close')
    expect(detach).not.toHaveBeenCalled()
  })
})

describe('the local socket confers no more than a remote pairing', () => {
  it('refuses the local machine with a bad credential, exactly as it refuses a remote', () => {
    // M4, the all-in-one case: the local daemon has no bootstrap special case.
    const local = harness([{ id: 'local', token: 'sekret' }])
    local.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'local', token: 'wrong', hostname: 'thishost' }),
    )
    const remote = harness([{ id: 'm1', token: 'sekret' }])
    remote.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'm1', token: 'wrong', hostname: 'box' }),
    )
    expect(local.attach).not.toHaveBeenCalled()
    expect(remote.attach).not.toHaveBeenCalled()
    expect(local.ws.sent.map((s) => JSON.parse(s).type)).toEqual(
      remote.ws.sent.map((s) => JSON.parse(s).type),
    )
  })

  it('gives the local machine the same principal SHAPE a remote one gets', () => {
    // Same kind, same capability form, a per-connection device: nothing about
    // being local widens what the principal carries.
    const local = harness([{ id: 'local', token: 'sekret' }])
    local.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'local', token: 'sekret', hostname: 'thishost' }),
    )
    const remote = harness([{ id: 'm1', token: 'tok' }])
    remote.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'b' }))

    const localPrincipal = local.attach.mock.calls[0]?.[0] as Record<string, string>
    const remotePrincipal = remote.attach.mock.calls[0]?.[0] as Record<string, string>
    expect(Object.keys(localPrincipal).sort()).toEqual(Object.keys(remotePrincipal).sort())
    expect(localPrincipal.kind).toBe('machine')
    expect(remotePrincipal.kind).toBe('machine')
    expect(localPrincipal.capability).toBe('cap:machine:local')
    expect(remotePrincipal.capability).toBe('cap:machine:m1')
    expect(localPrincipal.device).toMatch(/^daemon-\d+$/)
  })
})
