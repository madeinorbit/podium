/**
 * A HEADED (SERVER-FAMILY) SESSION'S CLIENT TUI STATES ITS SIZE THROUGH THE
 * HOST — POD-3809, rewritten for POD-4723 (design rev 3), end to end inside the
 * daemon.
 *
 * THE BUG POD-3809 PINNED. The client terminal was born at some size and
 * nothing told the server, so the view rendered the row's 80x24 until a later
 * ask. Under rev 3 the host's WELCOME states the size the client really has,
 * and the size event reports it — so the birth is reported without anyone
 * remembering to.
 *
 * WHAT REV 3 CHANGED HERE. An ask that arrives before the client exists is
 * dropped, not held: the server re-drives it. A later ask moves nothing until
 * the client's host answers, and the report is the KERNEL's answer. The client
 * is born at the session's last-known size (its model's), not at an ask.
 *
 * WHAT IT RUNS: the real `resize` handler, the real
 * `reconcileNativeClientTerminal`, and the real client-terminal host with only
 * its process ports injected.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { AgentFrame, DurableAttachment } from '@podium/process/screen'
import { describe, expect, it } from 'vitest'
import { createOpencodeClientTerminals } from '../runtime/opencode-attach'
import { sessionModelSize, trackSessionSize } from '../session-screens'
import type { ClientProcessOwner } from '../session/clients.js'
import type { DaemonContext } from './context'
import { onSessionSize, reconcileNativeClientTerminal, sessionHandlers, sessionSize } from './session'
import { testSessions } from '../session/testing.js'

const SESSION = asSessionId('22222222-2222-4222-8222-222222222222')

/** Sizes nowhere near a default: 120x40 or 80x24 here would let a fabricated
 *  size pass for a reported one. */
const LAST_KNOWN = { cols: 203, rows: 51 } as const

const target = {
  kind: 'opencode',
  conversation: 'ses_headed',
  endpoint: { address: 'http://127.0.0.1:41234', username: 'podium', secret: 'x'.repeat(64) },
  workdir: '/home/agent/work',
} as const

type Size = { cols: number; rows: number }

/** A host-backed client: WELCOME states the size it was born at, and the test
 *  plays the host's RESIZED. */
function fakeClient(
  welcome: Size,
  refuse: boolean,
): DurableAttachment & { sizes: Array<[number, number]>; state: (size: Size) => void } {
  const sizes: Array<[number, number]> = []
  let size = welcome
  const sizeCbs = new Set<(g: Size) => void>()
  return {
    sizes,
    state: (g) => {
      size = g
      for (const cb of [...sizeCbs]) cb(g)
    },
    pid: 4242,
    onFrame: (_cb: (f: AgentFrame) => void) => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: (cols: number, rows: number) => {
      sizes.push([cols, rows])
      return refuse ? Promise.reject(new Error('podium-host: not the writer')) : Promise.resolve()
    },
    size: () => size,
    onSize: (cb) => {
      sizeCbs.add(cb)
      return () => sizeCbs.delete(cb)
    },
    replay: async () => {},
    dispose: () => {},
  } as DurableAttachment & { sizes: Array<[number, number]>; state: (size: Size) => void }
}

interface Harness {
  ctx: DaemonContext
  sent: DaemonMessage[]
  /** The cols/rows the client terminal's process was CREATED at. */
  born: Array<[number, number]>
  clients: ReturnType<typeof fakeClient>[]
  /** The viewer opened Native: arm the request and let the reconcile run. */
  openNative(): Promise<void>
  /** Drain the fire-and-forget ask the resize path takes. */
  drain(): Promise<void>
}

function harness(over: { reportGeometry?: boolean; refuse?: boolean } = {}): Harness {
  const sent: DaemonMessage[] = []
  const born: Array<[number, number]> = []
  const clients: ReturnType<typeof fakeClient>[] = []

  const ctx = {
    backend: 'none',
    settingsDir: join(tmpdir(), 'podium-headed-client-geometry'),
    sessions: testSessions(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, flushNow: () => {} },
    observers: { clearSession: () => {}, onResize: () => {} },
    sessionCwdTracker: { clear: () => {} },
    primeInjector: { reset: () => {} },
    send: (msg: DaemonMessage) => {
      // THE SUPPRESSION SWITCH THAT ARMS THIS SUITE. With the report dropped the
      // daemon still does everything else exactly as before, and only the wire
      // goes quiet — which is precisely the shape of the POD-3809 bug.
      if (over.reportGeometry === false && msg.type === 'geometryApplied') return
      sent.push(msg)
    },
  } as unknown as DaemonContext

  // The real client-terminal host: only the session-owned process port is
  // injected, and it is wired to the daemon exactly as `host-runtime.ts`
  // wires it.
  const clientTerminals = createOpencodeClientTerminals({
    clients: {
      spawnClient: async (o) => {
        born.push([o.cols ?? 0, o.rows ?? 0])
        const client = fakeClient({ cols: o.cols ?? 0, rows: o.rows ?? 0 }, over.refuse === true)
        clients.push(client)
        return client as unknown as Awaited<ReturnType<ClientProcessOwner['spawnClient']>>
      },
      reclaimClient: async () => {},
      hasClientMaster: () => false,
    },
    // Wired exactly as `host-runtime.ts` wires them (POD-4723).
    sizeEvent: (sessionId, size) => onSessionSize(ctx, sessionId, size),
    birthGeometry: (sessionId) => sessionModelSize(ctx, sessionId),
    frames: () => {},
    releaseStream: () => {},
    sessions: ctx.sessions,
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
      ctx.sessions.ensure(SESSION).nativeRequested = true
      reconcileNativeClientTerminal(ctx, SESSION)
      // The reconcile is fire-and-forget; drain what its awaits are parked on.
      await ctx.sessions.get(SESSION)?.nativeTransition
      await new Promise((r) => setTimeout(r, 0))
    },
    drain: async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

function reports(sent: DaemonMessage[]): Array<{ cols: number; rows: number }> {
  return sent.flatMap((m) => (m.type === 'geometryApplied' ? [m.geometry] : []))
}

describe('an ask that arrives before the client exists', () => {
  it('is DROPPED: nothing held, nothing reported, nothing dispatched later', async () => {
    const h = harness()
    sessionHandlers.resize(h.ctx, { type: 'resize', sessionId: SESSION, cols: 96, rows: 27 })
    expect(reports(h.sent)).toEqual([])

    await h.openNative()
    await h.drain()
    // The client that opens later is never moved by an ask it did not see.
    expect(h.clients[0]?.sizes).toEqual([])
  })
})

describe('the client is born at the last-known size, and its WELCOME is the report', () => {
  it('opens at the model size and reports it exactly once', async () => {
    const h = harness()
    trackSessionSize(h.ctx, SESSION, LAST_KNOWN.cols, LAST_KNOWN.rows)

    await h.openNative()

    expect(h.born).toEqual([[LAST_KNOWN.cols, LAST_KNOWN.rows]])
    expect(h.clients[0]?.sizes).toEqual([])
    expect(reports(h.sent)).toEqual([LAST_KNOWN])
    expect(sessionSize(h.ctx, SESSION)).toEqual(LAST_KNOWN)
  })

  it('ARMED: with the report suppressed the daemon looks identical and the server hears nothing', async () => {
    const h = harness({ reportGeometry: false })
    trackSessionSize(h.ctx, SESSION, LAST_KNOWN.cols, LAST_KNOWN.rows)

    await h.openNative()

    expect(h.born).toEqual([[LAST_KNOWN.cols, LAST_KNOWN.rows]])
    expect(reports(h.sent)).toEqual([])
  })
})

describe('a later ask, once the client exists', () => {
  it('reaches the client once and is reported only when its host answers — at the kernel size', async () => {
    const h = harness()
    trackSessionSize(h.ctx, SESSION, LAST_KNOWN.cols, LAST_KNOWN.rows)
    await h.openNative()

    sessionHandlers.resize(h.ctx, { type: 'resize', sessionId: SESSION, cols: 96, rows: 27 })
    await h.drain()
    expect(h.clients[0]?.sizes).toEqual([[96, 27]])
    // The ask reported nothing.
    expect(reports(h.sent)).toEqual([LAST_KNOWN])

    // The host answers with what the kernel took, which need not be the ask.
    h.clients[0]?.state({ cols: 95, rows: 27 })
    expect(reports(h.sent)).toEqual([LAST_KNOWN, { cols: 95, rows: 27 }])
    expect(sessionModelSize(h.ctx, SESSION)).toEqual({ cols: 95, rows: 27 })
  })

  it('a refused ask reports nothing and moves nothing', async () => {
    const h = harness({ refuse: true })
    trackSessionSize(h.ctx, SESSION, LAST_KNOWN.cols, LAST_KNOWN.rows)
    await h.openNative()

    sessionHandlers.resize(h.ctx, { type: 'resize', sessionId: SESSION, cols: 96, rows: 27 })
    await h.drain()
    expect(reports(h.sent)).toEqual([LAST_KNOWN])
    expect(sessionSize(h.ctx, SESSION)).toEqual(LAST_KNOWN)
  })
})
