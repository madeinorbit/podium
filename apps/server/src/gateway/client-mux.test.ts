/**
 * THE CLIENT MUX (POD-390): the routing table is TOTAL, the gate FAILS CLOSED,
 * the principal comes from the transport, and the fan-out mechanism delivers the
 * same shape it delivered before the extraction.
 *
 * Several assertions here are NEGATIVE (a frame that must NOT route, a payload
 * value that must NOT become an identity), so the suite opens by proving the
 * instrument can say YES — a refusal-only suite passes against wiring that
 * routes nothing at all.
 */

import { CLIENT_PLANE_CLASS, type ClientMessage, type ServerMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { CLIENT_FRAME_PORTS, clientPortsFor } from './client-frame-routing'
import { ClientMux } from './client-mux'
import type { ClientFeaturePorts } from './client-ports'
import { CLIENT_PRINCIPAL_GRADE } from './client-principal'
import { ClientRegistry } from './client-registry'

/**
 * The two lookups the gate ANDs together are independently forceable to `null`
 * here. Both flags are false by default, so every other test in this file runs
 * against the real tables; only the two divergence tests flip one, and each
 * restores it in a `finally`.
 */
const forced = vi.hoisted(() => ({ plane: false, ports: false }))
vi.mock('./client-frame-routing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client-frame-routing')>()
  return {
    ...actual,
    clientPlaneClassFor: (type: string) =>
      forced.plane ? null : actual.clientPlaneClassFor(type),
    clientPortsFor: (type: string) => (forced.ports ? null : actual.clientPortsFor(type)),
  }
})

function harness() {
  const registry = new ClientRegistry()
  const ports: ClientFeaturePorts = {
    sessions: {
      onClientAttached: vi.fn(),
      onClientDetached: vi.fn(),
      onSessionClientFrame: vi.fn(),
    },
  }
  const mux = new ClientMux({ registry, ports })
  const sent: ServerMessage[] = []
  const id = mux.attachClient((msg) => sent.push(msg))
  return { registry, ports, mux, sent, id }
}

const A_ROUTABLE_FRAME = { type: 'attach', sessionId: 's1' } satisfies ClientMessage

describe('the instrument', () => {
  it('routes a well-formed frame to the sessions port', () => {
    const h = harness()
    h.mux.routeClientFrame(h.id, A_ROUTABLE_FRAME)
    expect(h.ports.sessions.onSessionClientFrame).toHaveBeenCalledTimes(1)
  })
})

describe('the routing table', () => {
  it('is total over the client frame union, in BOTH directions', () => {
    // `satisfies` in the table makes a MISSING type a compile error; this catches
    // the other direction (a row here that ADR 7's inventory does not classify),
    // which the type system cannot see.
    expect(Object.keys(CLIENT_FRAME_PORTS).sort()).toEqual(Object.keys(CLIENT_PLANE_CLASS).sort())
  })

  it('names a port for every frame the wire can carry', () => {
    for (const type of Object.keys(CLIENT_PLANE_CLASS)) {
      expect(clientPortsFor(type), type).not.toBeNull()
    }
  })

  it('keeps the liveness echo on the GATEWAY, not on a feature', () => {
    // `ping`/`pong` was in the sessions switch only because the switch was there.
    expect(clientPortsFor('ping')).toEqual(['transport'])
  })
})

describe('the gate fails closed', () => {
  it('REFUSES a frame type it cannot classify, rather than defaulting it', () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A type that is on neither table — protocol drift, a newer client, a hostile
    // peer. It must reach no port at all.
    h.mux.routeClientFrame(h.id, { type: 'notAFrame', sessionId: 's1' } as unknown as ClientMessage)
    expect(h.ports.sessions.onSessionClientFrame).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused unclassified client frame'))
    warn.mockRestore()
  })

  it('refuses when the PLANE INVENTORY cannot classify it, though the port table can', () => {
    // The two lookups are an AND on purpose, and no REAL frame can exercise that
    // (the table above pins the two key sets identical). So the divergence is
    // forced: this is the "frame classified in one table and forgotten in the
    // other" case, and an OR here would let it through as a default.
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    forced.plane = true
    try {
      h.mux.routeClientFrame(h.id, A_ROUTABLE_FRAME)
    } finally {
      forced.plane = false
    }
    expect(h.ports.sessions.onSessionClientFrame).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('refuses when the PORT TABLE cannot answer, though the plane inventory can', () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    forced.ports = true
    try {
      h.mux.routeClientFrame(h.id, A_ROUTABLE_FRAME)
    } finally {
      forced.ports = false
    }
    expect(h.ports.sessions.onSessionClientFrame).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('routes that SAME frame when neither lookup is forced — the forcing is real', () => {
    // Non-vacuity for the two tests above: without it they would pass against a
    // mock that refuses everything.
    const h = harness()
    h.mux.routeClientFrame(h.id, A_ROUTABLE_FRAME)
    expect(h.ports.sessions.onSessionClientFrame).toHaveBeenCalledTimes(1)
  })

  it('drops a frame for a connection that is not registered', () => {
    // There is no principal to route it under, so there is nothing to guess.
    const h = harness()
    h.mux.routeClientFrame('c999', A_ROUTABLE_FRAME)
    expect(h.ports.sessions.onSessionClientFrame).not.toHaveBeenCalled()
  })
})

describe('the principal comes from the AUTHENTICATED TRANSPORT', () => {
  it('mints it from the connection, never from a frame body', () => {
    const h = harness()
    // The forgery: `hello.clientId` is a real payload field naming ANOTHER
    // connection (it drives the reconnect reclaim). A frame claiming to be
    // someone else must still be delivered as itself.
    h.mux.routeClientFrame(h.id, {
      type: 'hello',
      clientId: 'attacker',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
    const call = vi.mocked(h.ports.sessions.onSessionClientFrame).mock.calls[0]
    expect(call?.[0].device).toBe(`client:${h.id}`)
    expect(call?.[1].id).toBe(h.id)
    // The payload value reaches the FEATURE (the reclaim needs it) but never
    // became the routing identity: no connection called 'attacker' exists.
    expect(h.registry.get('attacker')).toBeUndefined()
  })

  it('is device-grade, and says so — one shared password names no person', () => {
    // POD-351 / docs/multi-user-readiness.md §3.2. Pinned by test so promoting
    // this to a real user identity (POD-1075) is a visible, deliberate edit and
    // not something a green run can be read as already providing.
    const h = harness()
    const principal = h.mux.principalOf(h.id)
    expect(CLIENT_PRINCIPAL_GRADE).toBe('device')
    expect(principal?.kind).toBe('user')
    expect(principal?.user).toBe('user:sole')
  })

  it('gives two connections distinct DEVICES under the same user', () => {
    const h = harness()
    const second = h.mux.attachClient(() => {})
    expect(second).not.toBe(h.id)
    expect(h.mux.principalOf(second)?.device).not.toBe(h.mux.principalOf(h.id)?.device)
    expect(h.mux.principalOf(second)?.user).toBe(h.mux.principalOf(h.id)?.user)
  })
})

describe('the connection lifecycle', () => {
  it('registers, welcomes with the SERVER-minted id, then bootstraps the feature', () => {
    const h = harness()
    expect(h.sent[0]).toEqual({ type: 'welcome', clientId: h.id })
    expect(h.ports.sessions.onClientAttached).toHaveBeenCalledTimes(1)
    // The connection must be visible to the feature DURING its bootstrap: the
    // prepared-publication scheduler walks the connection set and would skip it.
    const conn = vi.mocked(h.ports.sessions.onClientAttached).mock.calls[0]?.[1]
    expect(h.registry.get(h.id)).toBe(conn)
  })

  it('removes the connection BEFORE the sweep, and hands the sweep its record', () => {
    const h = harness()
    vi.mocked(h.ports.sessions.onClientDetached).mockImplementation(() => {
      // Asserted from INSIDE the port call: a re-entrant fan-out during the sweep
      // must not reach a socket that is already gone.
      expect(h.registry.get(h.id)).toBeUndefined()
    })
    h.mux.detachClient(h.id)
    expect(h.ports.sessions.onClientDetached).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.ports.sessions.onClientDetached).mock.calls[0]?.[1].id).toBe(h.id)
  })

  it('is idempotent on a second close', () => {
    const h = harness()
    h.mux.detachClient(h.id)
    h.mux.detachClient(h.id)
    expect(h.ports.sessions.onClientDetached).toHaveBeenCalledTimes(1)
  })

  it('answers ping itself, without waking a feature', () => {
    const h = harness()
    h.mux.routeClientFrame(h.id, { type: 'ping' })
    expect(h.sent.at(-1)).toEqual({ type: 'pong' })
    expect(h.ports.sessions.onSessionClientFrame).not.toHaveBeenCalled()
  })
})

describe('the fan-out mechanism — delivery SHAPE, preserved', () => {
  /** Three connections, so "everyone" and "everyone but one" can differ. */
  function fanout() {
    const registry = new ClientRegistry()
    const mux = new ClientMux({
      registry,
      ports: {
        sessions: {
          onClientAttached: vi.fn(),
          onClientDetached: vi.fn(),
          onSessionClientFrame: vi.fn(),
        },
      },
    })
    const inboxes = new Map<string, ServerMessage[]>()
    const ids = ['a', 'b', 'c'].map(() => {
      const inbox: ServerMessage[] = []
      const id = mux.attachClient((msg) => inbox.push(msg))
      inboxes.set(id, inbox)
      return id
    })
    // Drop the welcomes so the assertions below read on fan-out alone.
    for (const inbox of inboxes.values()) inbox.length = 0
    return { registry, mux, ids, inboxes }
  }

  const NOTE: ServerMessage = { type: 'pong' }

  it('reaches EVERY connection, in registration order', () => {
    const f = fanout()
    f.registry.broadcast(NOTE)
    expect([...f.inboxes.values()].map((i) => i.length)).toEqual([1, 1, 1])
    expect([...f.registry.values()].map((c) => c.id)).toEqual(f.ids)
  })

  it('skips ONLY the originator when one is named (draft echo suppression)', () => {
    const f = fanout()
    const originator = f.ids[1] as string
    f.registry.broadcast(NOTE, { exceptClientId: originator })
    expect(f.inboxes.get(originator)).toEqual([])
    for (const [id, inbox] of f.inboxes) {
      if (id !== originator) expect(inbox).toEqual([NOTE])
    }
  })

  it('stops delivering to a connection the moment it is removed', () => {
    const f = fanout()
    const gone = f.ids[0] as string
    f.mux.detachClient(gone)
    f.registry.broadcast(NOTE)
    expect(f.inboxes.get(gone)).toEqual([])
    expect(f.registry.size).toBe(2)
  })

  it('does NOT scope by principal — that is POD-1077 and it is not built', () => {
    // Stated as a test so a green suite cannot be read as evidence of scoping.
    // Every connection here holds a distinct device principal and every one of
    // them still receives the broadcast.
    const f = fanout()
    const devices = [...f.registry.values()].map((c) => c.principal.device)
    expect(new Set(devices).size).toBe(3)
    f.registry.broadcast(NOTE)
    expect([...f.inboxes.values()].every((inbox) => inbox.length === 1)).toBe(true)
  })

  it('refuses to deliver prepared bytes to a connection with no prepared sink', () => {
    // The in-process form carries no publication authority; the caller's existing
    // `if (client.publication)` guards keep the same meaning.
    const f = fanout()
    const conn = f.registry.get(f.ids[0] as string)
    expect(conn && f.registry.deliverPrepared(conn, '{"type":"pong"}')).toBe(false)
  })

  it('delivers prepared bytes through the authority when there IS one', () => {
    const registry = new ClientRegistry()
    const mux = new ClientMux({
      registry,
      ports: {
        sessions: {
          onClientAttached: vi.fn(),
          onClientDetached: vi.fn(),
          onSessionClientFrame: vi.fn(),
        },
      },
    })
    const prepared: string[] = []
    const id = mux.attachClient({
      send: () => {},
      publication: {
        principal: 'operator',
        scope: 'all',
        serverRole: 'standalone',
        protocolVersion: 1,
        global: true,
        snapshot: () => ({ revision: 0, allowedSignature: 'global', allowedSessionIds: [] }),
        sendPrepared: (bytes) => prepared.push(bytes),
      },
    })
    const conn = registry.get(id)
    expect(conn && registry.deliverPrepared(conn, '{"type":"pong"}')).toBe(true)
    expect(prepared).toEqual(['{"type":"pong"}'])
  })
})
