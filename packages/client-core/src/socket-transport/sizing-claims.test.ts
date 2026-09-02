/**
 * SIZING PLAN ASSUMPTION TESTS — transport half (POD-3235, spec artifact SPEC-0b.md rev 2).
 *
 * The claims the terminal-sizing plan (POD-3190) makes about `SocketHub` /
 * `SessionConnection` today, executed against the real classes. Stage 1
 * (POD-3239) deletes the hub's hardcoded viewport and moves the authoritative
 * snapshot into `onAttached`; these tests are what make that a safe cut, and
 * they are rewritten in the same commit that changes the behaviour.
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

function makeHub(viewport = { cols: 80, rows: 24, dpr: 1 }): {
  hub: SocketHub
  socket: FakeSocket
} {
  let socket!: FakeSocket
  const hub = new SocketHub({
    url: 'ws://sizing.test',
    viewport,
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

describe('C1: a SessionConnection is born at the hub viewport and emits that state before any `attached`', () => {
  it('the birth grid is the hub option, not a constant inside SessionConnection', () => {
    const standard = makeHub()
    expect(standard.hub.attach(SESSION).state()).toMatchObject({ cols: 80, rows: 24 })

    // A different viewport lands a different birth grid — so 80x24 is the value
    // the composition root supplies, and stage 1's cut is at that call site.
    const wide = makeHub({ cols: 200, rows: 60, dpr: 1 })
    expect(wide.hub.attach(SESSION).state()).toMatchObject({ cols: 200, rows: 60 })
  })

  it('the composition root hardcodes 80x24 into every engine hub', () => {
    const seen: Array<{ cols: number; rows: number }> = []
    const createHub: CreateHub = (opts) => {
      seen.push({ cols: opts.viewport.cols, rows: opts.viewport.rows })
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
    expect(seen).toEqual([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
    ])
  })

  it('requestControl(geometry) emits the 80x24 state SYNCHRONOUSLY, before any attach has landed', () => {
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

    // One synchronous emit, at the BIRTH grid — the claimed 150x50 rides only in
    // requestedGeometry. This is the emit that moves a mounted view to 80x24.
    expect(events).toEqual(['state:80x24'])
    expect(states.at(-1)).toMatchObject({
      cols: 80,
      rows: 24,
      requestedGeometry: { cols: 150, rows: 50 },
    })
  })

  it('`welcome` re-emits the same 80x24 state through _notifyHubChange, still before `attached`', () => {
    const { hub, socket } = makeHub()
    const events: string[] = []
    hub.attach(SESSION, {
      onState: (s) => events.push(`state:${s.cols}x${s.rows}`),
      onAttached: () => events.push('attached'),
    })

    socket.deliver({ type: 'welcome', clientId: 'client-1' } as ServerMessage)

    expect(events).toEqual(['state:80x24'])
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
