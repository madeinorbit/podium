/**
 * A HEADED (SERVER-FAMILY) SESSION IS BORN AT THE VIEWER'S SIZE, AND SAYS SO —
 * POD-3809, stage 7 of POD-3190, end to end inside the daemon.
 *
 * THE BUG THIS PINS. A server-family session has no pty bridge, so the viewer's
 * first ask arrives before there is anything to resize: the handler parks it in
 * `pendingResizes`. The client terminal was then opened at the harness default
 * (120x40) and the held request dispatched to it afterwards — and NEITHER of
 * those two applies told the server. So the server's W stayed at the row's
 * 80x24, the browser (whose buffer only moves on a report) rendered 80x24, and
 * the view snapped to the right grid seconds later when some LATER ask happened
 * to land while the terminal existed. That is the "small top-left quadrant for a
 * couple of seconds".
 *
 * WHAT IT ASSERTS, IN ONE RUN OF THE REAL CODE: the real `resize` handler, the
 * real `reconcileNativeClientTerminal`, and the real client-terminal host with
 * only its process ports injected. Both halves are checked — the applied-size
 * RECORD (what the daemon believes) and the FRAMES the server received (what it
 * was told) — because the bug was precisely the two disagreeing.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { AgentFrame, AgentSession } from '@podium/pty'
import { describe, expect, it } from 'vitest'
import { createOpencodeClientTerminals } from '../runtime/opencode-attach'
import { appliedGeometryFor } from './applied-geometry'
import type { DaemonContext } from './context'
import { reconcileNativeClientTerminal, sessionHandlers } from './session'

const SESSION = asSessionId('22222222-2222-4222-8222-222222222222')

/** What the viewer asked for, and nothing near a default: 120x40 or 80x24 here
 *  would let a fabricated size pass for a reported one. */
const ASKED = { cols: 203, rows: 51 } as const

const target = {
  kind: 'opencode',
  conversation: 'ses_headed',
  endpoint: { address: 'http://127.0.0.1:41234', username: 'podium', secret: 'x'.repeat(64) },
  workdir: '/home/agent/work',
} as const

function fakeClient(): AgentSession & { sizes: Array<[number, number]> } {
  const sizes: Array<[number, number]> = []
  return {
    sizes,
    pid: 4242,
    onFrame: (_cb: (f: AgentFrame) => void) => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: (cols: number, rows: number) => {
      sizes.push([cols, rows])
    },
    redraw: () => {},
    redrawWhenReady: () => {},
    geometry: () => ({ cols: 0, rows: 0 }),
    dispose: () => {},
  } as unknown as AgentSession & { sizes: Array<[number, number]> }
}

interface Harness {
  ctx: DaemonContext
  sent: DaemonMessage[]
  /** The cols/rows the client terminal's process was CREATED at. */
  born: Array<[number, number]>
  clients: ReturnType<typeof fakeClient>[]
  /** The viewer opened Native: arm the request and let the reconcile run. */
  openNative(): Promise<void>
}

function harness(over: { reportGeometry?: boolean } = {}): Harness {
  const sent: DaemonMessage[] = []
  const born: Array<[number, number]> = []
  const clients: ReturnType<typeof fakeClient>[] = []

  const ctx = {
    backend: 'none',
    settingsDir: join(tmpdir(), 'podium-headed-client-geometry'),
    bridges: new Map<SessionId, AgentSession>(),
    pendingResizes: new Map<SessionId, { cols: number; rows: number }>(),
    durableLabels: new Map<SessionId, string>(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, flushNow: () => {} },
    observers: { clearSession: () => {}, onResize: () => {} },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
    send: (msg: DaemonMessage) => {
      // THE SUPPRESSION SWITCH THAT ARMS THIS SUITE. With the report dropped the
      // daemon still applies exactly as before — record, spawn size, everything
      // — and only the wire goes quiet, which is precisely the shape of the bug.
      if (over.reportGeometry === false && msg.type === 'geometryApplied') return
      sent.push(msg)
    },
  } as unknown as DaemonContext

  // The real client-terminal host: only the process ports are injected, and it
  // is wired to the daemon exactly as `host-runtime.ts` wires it.
  const clientTerminals = createOpencodeClientTerminals({
    appliedGeometry: appliedGeometryFor(ctx),
    birthGeometry: (sessionId) =>
      ctx.pendingResizes.get(sessionId) ?? appliedGeometryFor(ctx).applied(sessionId),
    frames: () => {},
    releaseStream: () => {},
    spawn: async (o) => {
      born.push([o.cols ?? 0, o.rows ?? 0])
      const client = fakeClient()
      clients.push(client)
      return client as unknown as Awaited<
        ReturnType<NonNullable<Parameters<typeof createOpencodeClientTerminals>[0]['spawn']>>
      >
    },
    reclaim: async () => {},
    hasMaster: () => false,
    setTimer: () => 0,
    clearTimer: () => {},
  })
  ctx.clientTerminals = clientTerminals

  // A server-family handle whose attach is the thing that really opens the
  // client terminal — the same call `createOpencodeHost` makes.
  const handle = {
    binding: {
      sessionId: SESSION,
      family: 'server',
      driver: 'opencode',
      transitionId: 't-headed',
      process: { key: 'podium-oc-22222222', pid: 999 },
    },
    attach: async () => {
      await clientTerminals.attach({ sessionId: SESSION, target })
      return { kind: 'client' as const, address: 'http://127.0.0.1:41234' }
    },
    lease: { release: async () => {} },
  }
  ctx.agentRuntime = { handleFor: () => handle } as unknown as DaemonContext['agentRuntime']

  return {
    ctx,
    sent,
    born,
    clients,
    openNative: async () => {
      ctx.nativeClientRequests ??= new Set<SessionId>()
      ctx.nativeClientRequests.add(SESSION)
      reconcileNativeClientTerminal(ctx, SESSION)
      // The reconcile is fire-and-forget; drain what its awaits are parked on.
      await ctx.nativeClientTransitions?.get(SESSION)
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

function reports(sent: DaemonMessage[]): Array<{ cols: number; rows: number }> {
  return sent.flatMap((m) => (m.type === 'geometryApplied' ? [m.geometry] : []))
}

describe('an ask that arrives before the terminal exists', () => {
  it('is HELD and reports nothing — there is no applied grid yet', () => {
    const { ctx, sent } = harness()

    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, ...ASKED })

    expect(ctx.pendingResizes.get(SESSION)).toEqual(ASKED)
    // A held request is not an applied grid, and reporting one would be the lie
    // stage 5 removed. Silence here is correct; silence AFTER the attach is not.
    expect(reports(sent)).toEqual([])
  })

  it('opens the client terminal AT the asked size and reports it exactly once', async () => {
    const h = harness()

    sessionHandlers.resize(h.ctx, { type: 'resize', sessionId: SESSION, ...ASKED })
    await h.openNative()

    // BORN RIGHT, not corrected. The process was created at the viewer's grid,
    // so the very first frame it paints is the right shape — no 120x40 pass.
    expect(h.born).toEqual([[ASKED.cols, ASKED.rows]])
    // …and nothing resized it afterwards, which is what stops the extra SIGWINCH
    // and the TUI repaint that came with it.
    expect(h.clients[0]?.sizes).toEqual([])

    // WHAT THE DAEMON BELIEVES.
    expect(appliedGeometryFor(h.ctx).applied(SESSION)).toEqual(ASKED)
    // WHAT THE SERVER WAS TOLD — the half that used to be missing entirely.
    // EXACTLY ONE: the birth reports, and the native reconcile then finds the
    // record already at the held size and retires the request instead of
    // dispatching it again.
    expect(reports(h.sent)).toEqual([ASKED])
    expect(h.sent.filter((m) => m.type === 'geometryApplied')).toEqual([
      { type: 'geometryApplied', sessionId: SESSION, geometry: ASKED, cause: 'request' },
    ])

    // The request is consumed, not left to fire on the next reconcile.
    expect(h.ctx.pendingResizes.has(SESSION)).toBe(false)
  })

  it('ARMED: with the report suppressed the daemon looks identical and the server hears nothing', async () => {
    // The pre-POD-3809 daemon, reproduced by dropping only the frame. Everything
    // the assertions above check about the daemon's own state still holds — which
    // is exactly why the bug survived review: the daemon was right and silent.
    const h = harness({ reportGeometry: false })

    sessionHandlers.resize(h.ctx, { type: 'resize', sessionId: SESSION, ...ASKED })
    await h.openNative()

    expect(h.born).toEqual([[ASKED.cols, ASKED.rows]])
    expect(appliedGeometryFor(h.ctx).applied(SESSION)).toEqual(ASKED)
    // …and the assertion the test above makes now FAILS. The server's W would
    // never move, and the viewer would keep rendering the row's 80x24.
    expect(reports(h.sent)).toEqual([])
  })
})

describe('a later ask, once the client terminal exists', () => {
  it('goes down the client-terminal arm and reports the new grid', async () => {
    const h = harness()
    sessionHandlers.resize(h.ctx, { type: 'resize', sessionId: SESSION, ...ASKED })
    await h.openNative()

    sessionHandlers.resize(h.ctx, { type: 'resize', sessionId: SESSION, cols: 96, rows: 27 })

    // Dispatched to the real client this time — there is one now — and reported
    // by the same operation that recorded it.
    expect(h.clients[0]?.sizes).toEqual([[96, 27]])
    expect(appliedGeometryFor(h.ctx).applied(SESSION)).toEqual({ cols: 96, rows: 27 })
    expect(reports(h.sent)).toEqual([ASKED, { cols: 96, rows: 27 }])
    // Nothing is held: it was applied, so it is not a pending request.
    expect(h.ctx.pendingResizes.has(SESSION)).toBe(false)
  })
})
