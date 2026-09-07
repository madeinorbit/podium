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

import { asUserId, asSessionId } from '@podium/model'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../relay'
import { wireDaemonSocket } from './daemon-socket'
import { openTestStore } from '../test-support/open-test-store'

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
    emit: async (ev: string, ...a: unknown[]) => {
      for (const handler of handlers[ev] ?? []) await handler(...a)
    },
    /**
     * Deliver WITHOUT awaiting, which is what the socket does when two frames
     * arrive in one read. `emit` above awaits each handler and therefore makes
     * every delivery sequential — it cannot express two frames in flight at once.
     */
    emitConcurrently: (ev: string, ...a: unknown[]): unknown[] =>
      (handlers[ev] ?? []).map((handler) => handler(...a)),
  }
}

const frame = (v: unknown): string => JSON.stringify(v)

const A_ROUTABLE_FRAME = {
  type: 'bind',
  sessionId: asSessionId('s1'),
  cmd: 'claude',
  cwd: '/tmp',
  agentKind: 'claude-code',
  geometry: { cols: 80, rows: 24 },
}

/** A registry with `machines` rows and spies on the gateway's two entry points. */
async function harness(machines: { id: string; token: string }[]) {
  const store = await openTestStore(':memory:')
  for (const m of machines) {
    await store.machines.upsertMachine({
      id: m.id,
      name: m.id,
      hostname: m.id,
      tokenHash: sha256(m.token),
      ownerUserId: asUserId('user:sole'),
    })
  }
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const attach = vi.spyOn(reg.gateway, 'attachDaemon')
  const route = vi.spyOn(reg.gateway, 'routeDaemonFrame').mockResolvedValue(undefined)
  const ws = fakeWs()
  wireDaemonSocket(ws as never, reg)
  return { store, reg, ws, attach, route }
}

describe('the instrument', () => {
  it('attaches and routes for a daemon that IS recognised', async () => {
    // Without this, every refusal below could be a socket that routes nothing at
    // all — a refusal-only suite that would pass against a broken wiring.
    const h = await harness([{ id: 'm1', token: 'tok' }])
    await h.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'm1' }))
    expect(h.attach).toHaveBeenCalledTimes(1)
    await h.ws.emit('message', frame(A_ROUTABLE_FRAME))
    expect(h.route).toHaveBeenCalledTimes(1)
  })
})

describe('a daemon that cannot prove who it is', () => {
  it('rejects an UNPAIRED machine and admits nothing', async () => {
    const h = await harness([])
    await h.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'ghost', token: 'whatever', hostname: 'ghost' }),
    )
    expect(h.attach).not.toHaveBeenCalled()
    expect(h.ws.sent.some((s) => s.includes('helloRejected'))).toBe(true)
  })

  it('rejects a REVOKED credential — the machine row alone is not admission', async () => {
    // Rotating the token is revocation of the old one. The machine still exists,
    // is still named, and is still in the fleet; a daemon holding the previous
    // secret must get nothing, not a degraded session.
    const h = await harness([{ id: 'm1', token: 'old' }])
    await h.store.machines.upsertMachine({
      id: 'm1',
      name: 'm1',
      hostname: 'm1',
      tokenHash: sha256('rotated'),
      ownerUserId: asUserId('user:sole'),
    })
    await h.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'old', hostname: 'm1' }))
    expect(h.attach).not.toHaveBeenCalled()
    expect(h.ws.sent.some((s) => s.includes('helloRejected'))).toBe(true)
  })

  it('rejects a valid token presented under ANOTHER machine id, rather than rebinding', async () => {
    const h = await harness([
      { id: 'm1', token: 'tok1' },
      { id: 'm2', token: 'tok2' },
    ])
    await h.ws.emit('message', frame({ type: 'hello', machineId: 'm2', token: 'tok1', hostname: 'm2' }))
    expect(h.attach).not.toHaveBeenCalled()
  })

  it('keeps a REJECTED socket rejected: later frames reach no feature port', async () => {
    const h = await harness([{ id: 'm1', token: 'tok' }])
    await h.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'wrong', hostname: 'm1' }))
    expect(h.attach).not.toHaveBeenCalled()
    // A retry with the CORRECT token on the same socket must not succeed — a
    // socket that can retry into a usable connection is an oracle for guessing.
    await h.ws.emit('message', frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'm1' }))
    expect(h.attach).not.toHaveBeenCalled()
    // And application traffic never routes.
    await h.ws.emit('message', frame(A_ROUTABLE_FRAME))
    expect(h.route).not.toHaveBeenCalled()
  })

  it('drops pre-auth application traffic without creating a principal', async () => {
    const h = await harness([{ id: 'm1', token: 'tok' }])
    await h.ws.emit('message', frame(A_ROUTABLE_FRAME))
    expect(h.route).not.toHaveBeenCalled()
    expect(h.attach).not.toHaveBeenCalled()
    // Closing an unattached socket must not detach a machine that may have a
    // healthy daemon on another socket.
    const detach = vi.spyOn(h.reg.gateway, 'detachDaemon')
    await h.ws.emit('close')
    expect(detach).not.toHaveBeenCalled()
  })
})

describe('the local socket confers no more than a remote pairing', () => {
  it('refuses the local machine with a bad credential, exactly as it refuses a remote', async () => {
    // M4, the all-in-one case: the local daemon has no bootstrap special case.
    const local = await harness([{ id: 'local', token: 'sekret' }])
    await local.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'local', token: 'wrong', hostname: 'thishost' }),
    )
    const remote = await harness([{ id: 'm1', token: 'sekret' }])
    await remote.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'm1', token: 'wrong', hostname: 'box' }),
    )
    expect(local.attach).not.toHaveBeenCalled()
    expect(remote.attach).not.toHaveBeenCalled()
    expect(local.ws.sent.map((s) => JSON.parse(s).type)).toEqual(
      remote.ws.sent.map((s) => JSON.parse(s).type),
    )
  })

  it('gives the local machine the same principal SHAPE a remote one gets', async () => {
    // Same kind, same capability form, a per-connection device: nothing about
    // being local widens what the principal carries.
    const local = await harness([{ id: 'local', token: 'sekret' }])
    await local.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'local', token: 'sekret', hostname: 'thishost' }),
    )
    const remote = await harness([{ id: 'm1', token: 'tok' }])
    await remote.ws.emit(
      'message',
      frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'b' }),
    )

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

/**
 * ADMISSION IS ONE-AT-A-TIME, EVEN WHEN THE FRAMES ARE NOT (POD-3469).
 *
 * Authenticating a hello is asynchronous — it reads the machines table — so the
 * acceptor's "second hello on an established connection" refusal cannot help
 * here: that state is only reached AFTER the credential lookup resolves. Two
 * hellos delivered in the same tick would both pass the guard while the first
 * lookup is still in flight, and the socket would attach the daemon twice.
 *
 * The socket closes that window by serializing pre-auth frames onto one chain,
 * so the acceptor sees them strictly in order. The existing refusal test sends
 * its second hello AFTER awaiting the first, so it is sequential by construction
 * and cannot observe this; that is why this case is written separately.
 */
describe('two hello frames arriving in one tick', () => {
  it('attaches the daemon exactly once', async () => {
    const h = await harness([{ id: 'm1', token: 'tok' }])
    const hello = frame({ type: 'hello', machineId: 'm1', token: 'tok', hostname: 'm1' })

    await Promise.all([
      ...h.ws.emitConcurrently('message', hello),
      ...h.ws.emitConcurrently('message', hello),
    ])

    expect(h.attach).toHaveBeenCalledTimes(1)
  })
})
