/**
 * The server's statement path (POD-3239 B6, reshaped by POD-4771).
 *
 * A viewer states its box; the server records it and reconciles. What is
 * pinned here is the frame vocabulary — the `viewportRequest` statement, the
 * legacy `resize` and the legacy geometry-bearing `requestControl` — and that a
 * forward never writes the copy. The reconcile rule itself, the bind and the
 * broadcast-on-change rule are pinned in `terminal-size-reconcile.test.ts`.
 */

import { asSessionId, asUserId, firstAdminMemberId, type Geometry } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { userClientPrincipal } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionTerminal, type ViewportRequest } from './terminal'

const SESSION = asSessionId('s-request')
const OWNER = asUserId(firstAdminMemberId())
const GEO: Geometry = { cols: 80, rows: 24 }

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
    wireVersion: 1,
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

/** Attached, visible, native, and controller. */
function controllerOf(terminal: SessionTerminal, id = 'c1'): Sent {
  const client = makeClient(id)
  client.viewVisible.add(SESSION)
  client.viewModes = { [SESSION]: 'native' }
  terminal.attachClient(client)
  expect(terminal.controllerId).toBe(client.id)
  return client
}

/** Visible and native, but not (yet) the controller. */
function rendererOf(terminal: SessionTerminal, id: string): Sent {
  const client = makeClient(id)
  client.viewVisible.add(SESSION)
  client.viewModes = { [SESSION]: 'native' }
  terminal.attachClient(client)
  return client
}

const request = (over: Partial<ViewportRequest> = {}): ViewportRequest => ({
  geometry: { cols: 132, rows: 43 },
  claimControl: false,
  ...over,
})

const resizesTo = (toDaemon: ControlMessage[]) =>
  toDaemon
    .filter((m): m is Extract<ControlMessage, { type: 'resize' }> => m.type === 'resize')
    .map((m) => ({ cols: m.cols, rows: m.rows }))

describe('claims', () => {
  it('a claiming statement takes control and forwards its size in one mutation', () => {
    const { terminal, toDaemon } = makeTerminal()
    const owner = controllerOf(terminal, 'c-owner')
    const claimer = rendererOf(terminal, 'c-claimer')
    toDaemon.length = 0
    owner.sent.length = 0

    const changed = terminal.handleViewportRequest(claimer.id, request({ claimControl: true }))

    expect(changed).toBe(true)
    expect(terminal.controllerId).toBe(claimer.id)
    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])
    expect(owner.sent.filter((m) => m.type === 'controllerChanged')).toHaveLength(1)
  })

  it('ONE CLAIM, ONE RESIZE: the sole-renderer promotion after it re-asks nothing (POD-4721)', () => {
    // `inbox.handleViewportRequest` runs the claim and then
    // `reconcileActiveRenderer`, which calls `requestControl` for the same
    // viewer again. The copy has not moved yet (only the report moves it), so
    // it is `lastForwarded` that keeps the second pass from re-sending.
    const { terminal, toDaemon } = makeTerminal()
    const client = controllerOf(terminal, 'c-reveal')
    toDaemon.length = 0

    terminal.handleViewportRequest(client.id, request({ claimControl: true }))
    terminal.requestControl(client.id) // what reconcileActiveRenderer does next

    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])
    expect(toDaemon.filter((m) => m.type === 'redraw')).toEqual([])

    terminal.applyDaemonGeometry({ cols: 132, rows: 43 })
    terminal.requestControl(client.id)
    expect(resizesTo(toDaemon)).toEqual([{ cols: 132, rows: 43 }])
  })
})

describe('the legacy frames still work', () => {
  it('a legacy `resize` is a non-claiming statement: recorded and reconciled', () => {
    const { terminal, toDaemon } = makeTerminal()
    const client = controllerOf(terminal, 'c-legacy')
    toDaemon.length = 0

    terminal.handleResize(client.id, 120, 40)
    terminal.handleResize(client.id, 121, 41)

    expect(resizesTo(toDaemon)).toEqual([
      { cols: 120, rows: 40 },
      { cols: 121, rows: 41 },
    ])
    expect(client.viewports.get(SESSION)).toEqual({ cols: 121, rows: 41 })
  })

  it('a legacy geometry-bearing `requestControl` still transfers control and forwards its size', () => {
    const { terminal, toDaemon } = makeTerminal()
    const owner = controllerOf(terminal, 'c-owner')
    const claimer = rendererOf(terminal, 'c-legacy-claim')
    toDaemon.length = 0
    owner.sent.length = 0

    terminal.requestControl(claimer.id, { cols: 62, rows: 36 })

    expect(terminal.controllerId).toBe(claimer.id)
    expect(resizesTo(toDaemon)).toEqual([{ cols: 62, rows: 36 }])
    expect(owner.sent.filter((m) => m.type === 'controllerChanged')).toHaveLength(1)
  })
})

describe('a forward writes nothing', () => {
  it('the statement is forwarded and that is all; the report moves the copy and announces it', () => {
    const { terminal, toDaemon } = makeTerminal()
    const client = controllerOf(terminal, 'c-modern')
    toDaemon.length = 0
    client.sent.length = 0

    terminal.handleViewportRequest(client.id, request({ geometry: { cols: 120, rows: 40 } }))

    expect(resizesTo(toDaemon)).toEqual([{ cols: 120, rows: 40 }])
    expect(terminal.geometry).toEqual(GEO)
    expect(client.sent.filter((m) => m.type === 'geometry')).toEqual([])

    terminal.applyDaemonGeometry({ cols: 120, rows: 40 })
    expect(terminal.geometry).toEqual({ cols: 120, rows: 40 })
    expect(client.sent.filter((m) => m.type === 'geometry')).toHaveLength(1)
  })
})
