/**
 * SIZING PLAN ASSUMPTION TESTS — transport half (POD-3235, spec artifact SPEC-0b.md rev 2).
 *
 * The claims the terminal-sizing plan (POD-3190) makes about `SocketHub` /
 * `SessionConnection`, executed against the real classes.
 *
 * C1 has been REWRITTEN by POD-3239 B2/B8, which is the cut these tests existed
 * to make safe: the hub's hardcoded viewport is gone and a connection now has no
 * geometry until `attached`. C3 is unchanged and is what B2 rests on.
 */

import { asSessionId } from '@podium/model'
import { encode, type ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CreateHub, createEngineHub } from '../engine/wiring'
import { applyLegacyMetadataState } from '../replica/legacy-wire-v1-binding'
import type { LegacyMetadataAppliedState } from '../replica/legacy-wire-v1-feed'
import { createReplica, memoryStorage } from '../replica/replica'
import { type ConnectionState, SocketHub, type WebSocketLike } from './socket-hub'

const SESSION = asSessionId('s-sizing')

class FakeSocket implements WebSocketLike {
  readonly sent: Array<Record<string, unknown>> = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  deliver(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
}

const hubs: SocketHub[] = []
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.dispose()
  vi.useRealTimers()
})

function makeHub(): {
  hub: SocketHub
  socket: FakeSocket
} {
  let socket!: FakeSocket
  const hub = new SocketHub({
    url: 'ws://sizing.test',
    makeSocket: () => {
      socket = new FakeSocket()
      return socket
    },
  })
  hubs.push(hub)
  hub.connect()
  socket.open()
  return { hub, socket }
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

describe('C1 (REWRITTEN for POD-3239 B2/B8): a SessionConnection has NO geometry until `attached`', () => {
  it('a fresh connection reports no grid at all — there is no number to invent', () => {
    // WHAT THIS REPLACES. The connection used to be born at the hub's `hello`
    // viewport, a hardcoded 80x24 with nothing to do with any session, and it
    // EMITTED that birth grid synchronously (see the two tests below). A mounted
    // terminal following `onState` was therefore moved to 80x24 before the
    // attach had said anything — the top-left quadrant, at its source.
    const { hub } = makeHub()
    expect(hub.attach(SESSION).state()).toMatchObject({ cols: undefined, rows: undefined })
  })

  it('the composition root supplies no viewport at all any more', () => {
    // The cut is AT THE CALL SITE, which is why this reads the composition root
    // rather than the class: `SocketHubOptions` no longer has the field, so
    // there is nowhere left for a birth grid to come from.
    const seen: Array<Record<string, unknown>> = []
    const createHub: CreateHub = (opts) => {
      seen.push(opts as unknown as Record<string, unknown>)
      return { dispose: () => {} } as unknown as SocketHub
    }
    const replica = createReplica({ storage: memoryStorage() })
    createEngineHub({
      wsClientUrl: 'ws://sizing.test',
      api: {} as never,
      replica,
      onFatalError: () => {},
      createHub,
      feed: { frame: () => {}, reset: () => {} } as never,
    })
    createEngineHub({
      wsClientUrl: 'ws://sizing.test',
      api: { sync: { changesSince: { query: async () => ({}) } } } as never,
      replica,
      onFatalError: () => {},
      createHub,
    })
    expect(seen).toHaveLength(2)
    for (const opts of seen) expect(opts).not.toHaveProperty('viewport')
  })

  it('requestControl(geometry) still emits synchronously — carrying NO grid, only the request', () => {
    // The emit is kept: `requestedGeometry` is real local intent and the UI reads
    // it. What is gone is the fabricated `cols`/`rows` it used to carry.
    const { hub } = makeHub()
    const states: ConnectionState[] = []
    const events: string[] = []
    const conn = hub.attach(SESSION, {
      onState: (s) => {
        states.push(s)
        events.push(`state:${s.cols}x${s.rows}`)
      },
      onAttached: () => events.push('attached'),
    })

    conn.requestControl({ cols: 150, rows: 50 })

    expect(events).toEqual(['state:undefinedxundefined'])
    expect(states.at(-1)).toMatchObject({
      cols: undefined,
      rows: undefined,
      requestedGeometry: { cols: 150, rows: 50 },
    })
  })

  it('`welcome` re-emits through _notifyHubChange, and it too carries no grid', () => {
    const { hub, socket } = makeHub()
    const events: string[] = []
    hub.attach(SESSION, {
      onState: (s) => events.push(`state:${s.cols}x${s.rows}`),
      onAttached: () => events.push('attached'),
    })

    socket.deliver({ type: 'welcome', clientId: 'client-1' } as ServerMessage)

    expect(events).toEqual(['state:undefinedxundefined'])
  })

  it('the hello frame still carries a viewport, because the wire requires one', () => {
    // It is a transport bootstrap and no server code reads it. Pinned so nobody
    // deletes the field and breaks the handshake schema while tidying up.
    const { hub, socket } = makeHub()
    void hub
    const hello = socket.sent.find((m) => m.type === 'hello')
    expect(hello?.viewport).toMatchObject({ cols: 80, rows: 24 })
  })
})

// ---------------------------------------------------------------------------
// C3 (client half)
// ---------------------------------------------------------------------------

describe('C3: the `attached` handler sets cols/rows and emits BEFORE onAttached', () => {
  it('onState carrying the attach geometry precedes onAttached, and state() already reads it there', () => {
    const { hub, socket } = makeHub()
    const events: string[] = []
    let stateInsideOnAttached: ConnectionState | undefined
    const conn = hub.attach(SESSION, {
      onState: (s) => events.push(`state:${s.cols}x${s.rows}`),
      onAttached: () => {
        events.push('attached')
        stateInsideOnAttached = conn.state()
      },
      onReset: () => events.push('reset'),
    })

    socket.deliver({
      type: 'attached',
      sessionId: SESSION,
      controllerId: 'other-client',
      controllerIdentity: null,
      geometry: { cols: 150, rows: 50 },
      geometryRevision: 3,
      epoch: 1,
      resumed: false,
      outputSeen: false,
    } as ServerMessage)

    // The full replay clear comes first, then the state emit, and onAttached LAST.
    expect(events).toEqual(['reset', 'state:150x50', 'attached'])
    // So there is no later event to wait for: the attach snapshot is readable
    // from `state()` inside onAttached, which is what SPEC-1 B2 relies on.
    expect(stateInsideOnAttached).toMatchObject({ cols: 150, rows: 50, geometryRevision: 3 })
  })

  it('an attach at the SAME grid as the birth default still emits — the emit is unconditional', () => {
    const { hub, socket } = makeHub()
    const events: string[] = []
    hub.attach(SESSION, {
      onState: (s) => events.push(`state:${s.cols}x${s.rows}`),
      onAttached: () => events.push('attached'),
    })
    socket.deliver({
      type: 'attached',
      sessionId: SESSION,
      controllerId: null,
      controllerIdentity: null,
      geometry: { cols: 80, rows: 24 },
      geometryRevision: 0,
      epoch: 0,
      resumed: true,
      outputSeen: true,
    } as ServerMessage)
    expect(events).toEqual(['state:80x24', 'attached'])
  })
})

// ---------------------------------------------------------------------------
// C10 (replica half)
// ---------------------------------------------------------------------------

describe('C10: the server geometry reaches the client session row through the replica', () => {
  it('a session row keeps the server value verbatim', () => {
    const replica = createReplica({ storage: memoryStorage() })
    const state = {
      cursor: 1,
      sessions: [
        {
          sessionId: 'sess-1',
          cwd: '/w',
          status: 'live',
          controllerId: null,
          geometry: { cols: 132, rows: 43 },
          epoch: 0,
          clientCount: 0,
          createdAt: '2026-06-03T00:00:00.000Z',
          lastActiveAt: '2026-06-03T00:00:00.000Z',
          origin: { kind: 'spawn' },
          machineId: 'm-1',
        },
      ],
      issues: [],
      issueProjections: [],
      issueDeps: [],
      repos: [],
      conversations: [],
      automations: [],
      automationRuns: [],
    } as unknown as LegacyMetadataAppliedState

    applyLegacyMetadataState(replica, state)

    const row = replica.rows('sessions')[0] as unknown as { geometry: unknown }
    expect(row.geometry).toEqual({ cols: 132, rows: 43 })
  })
})
