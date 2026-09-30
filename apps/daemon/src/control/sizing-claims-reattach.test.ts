/**
 * SIZING PLAN ASSUMPTION TESTS — C16, daemon half (POD-3235, SPEC-0b.md rev 2;
 * rewritten for POD-3279's rule 1 rev 4).
 *
 * Its own file because it must mock `@podium/process/durable`,
 * `@podium/process/host` and `@podium/process/abduco` at module scope: the claim
 * is about what the reattach handler does AROUND the durable attach, so the
 * attach itself is stubbed and the real handler runs. The abduco half of C16
 * (`repaintOnAttach` defaulting to true) is executed for real against a vendored
 * abduco in `packages/pty/src/abduco-winsize.integration.test.ts`; abduco
 * sessions an older Podium started are adopted, never created (POD-4986).
 *
 * WHAT CHANGED AT STAGE 3: the bind used to carry `msg.geometry` back, which was
 * the server's own last-known returned to it as a daemon report. A size-neutral
 * attach applies nothing, so the bind now carries NO geometry — unless the
 * daemon was holding a resize for this session, which it dispatches at bind and
 * may therefore report. The redraw half of the original claim is unchanged.
 *
 * WHAT CHANGED AT STAGE 4 (POD-3276): last-known no longer reaches the attach as
 * a `cols`/`rows` it could apply — for an adopted abduco session only as
 * no geometry to announce to a running legacy master.
 *
 * WHAT CHANGED WITH POD-4723 (design rev 3): the bind carries the CONNECTION's
 * size — what the host's WELCOME read back from the kernel — and nothing else;
 * a connection that reports no size binds bare, and abduco cannot read its size
 * back, so an adopted abduco session binds bare. There is no held resize to
 * dispatch at bind, and the reattach never nudges the program: no redraw, no
 * resize, no Ctrl-L.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import { createDurableProcess } from '@podium/process/durable'
import type { DurableAttachment } from '@podium/process/screen'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { attachTestTerminal, testSessions } from '../session/testing.js'

const SESSION = asSessionId('s-sizing-reattach')

const stub = vi.hoisted(() => {
  const state = {
    /** Bytes written to the program: a repaint nudge would show up here. */
    writes: 0,
    resizes: [] as Array<[number, number]>,
    attachedAt: [] as unknown[],
    /** The size the host's WELCOME read back from the kernel; unset = none reported. */
    size: undefined as { cols: number; rows: number } | undefined,
    /** Which kind holds the label: a podium-host, or an abduco master an older Podium started. */
    holder: 'host' as 'host' | 'abduco',
  }
  const session = {
    pid: 4321,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {
      state.writes += 1
    },
    writeBytes: () => {
      state.writes += 1
    },
    resize: (cols: number, rows: number) => {
      state.resizes.push([cols, rows])
    },
    size: () => state.size,
    // The host adapter awaits `ready` (the WELCOME) before it returns.
    ready: Promise.resolve(),
    dispose: () => {},
  }
  const SOCKET = '/tmp/podium-sizing-claims-reattach.sock'
  const hostLeaves = {
    hostHasSession: async () => state.holder === 'host',
    hostSocketPath: () => SOCKET,
    liveHostSocket: async () => (state.holder === 'host' ? SOCKET : undefined),
    listLiveHostLabels: async () => [],
    attachHostAgent: (opts: unknown) => {
      state.attachedAt.push(opts)
      return { ...session, ready: Promise.resolve(4242) }
    },
    killHostSession: async () => {},
    spawnHostAgent: async () => session,
    waitForHostSocket: async () => SOCKET,
  }
  const abducoLeaves = {
    abducoHasSession: async () => state.holder === 'abduco',
    abducoSocketPath: () => (state.holder === 'abduco' ? SOCKET : undefined),
    attachAbducoAgent: (opts: unknown) => {
      state.attachedAt.push(opts)
      return { ...session, ready: Promise.resolve(4242) }
    },

    killAbducoSession: async () => {},
    listLiveAbducoLabels: () => [],
    reapStaleAbducoBindTemps: () => [],
    waitForAbducoSocket: async () => SOCKET,
  }
  return { state, session, hostLeaves, abducoLeaves }
})

vi.mock('@podium/process/durable', async (importOriginal) => {
  // Spread the real door so durableProcessFor, createDurableProcess and the
  // adapter stay REAL: the claim is about what the reattach handler does
  // AROUND the durable attach, so only the leaf functions below are stubbed. A
  // whole-module stub hides durableProcessFor, the handler finds no durable
  // process and answers reattachFailed without ever building the bind frame.
  const actual = await importOriginal<typeof import('@podium/process/durable')>()
  return { ...actual, ...stub.hostLeaves, ...stub.abducoLeaves }
})

// The REAL host adapter kept real by the spread above reaches its leaves
// through `./host.js`, not through the door — `@podium/process/*` resolves to
// `packages/pty/src/*.ts`, so this is the same module record the adapter
// imports. Stubbing the door alone leaves the real locate() probing the real
// filesystem, finding nothing at the fake socket path and failing the reattach
// (POD-4008). The same leaf stubs here let locate() hit the stubbed socket
// path, and the real adapter then builds its attach options itself on its way
// down to the stubbed attachHostAgent — which is why the stub lives at the
// LEAF, not at adapter.attach.
vi.mock('@podium/process/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/process/durable')>()
  return { ...actual, ...stub.hostLeaves }
})

// Same for the abduco adoption adapter, which reaches its leaves through
// `./abduco.js`; the real adapter adds sizeNeutral itself on its
// way down to the stubbed attachAbducoAgent.
vi.mock('@podium/process/abduco', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/process/durable')>()
  return { ...actual, ...stub.abducoLeaves }
})

const { sessionHandlers } = await import('./session')
const { createTerminalRuntime } = await import('@podium/harness/driver/host')
const { daemonRuntimeHost } = await import('../runtime/host')
const { driverSlotsOver } = await import('../session/driver-slots.js')

type BindFrame = { type: 'bind'; geometry?: { cols: number; rows: number } }

/** The module-scope stub is shared across tests; each one starts from zero. */
function reset(): void {
  stub.state.writes = 0
  stub.state.resizes.length = 0
  stub.state.attachedAt.length = 0
  stub.state.size = undefined
  stub.state.holder = 'host'
}

function reattachMessage() {
  return {
    type: 'reattach',
    sessionId: SESSION,
    durableLabel: 'podium-s-sizing-reattach',
    cwd: '/w',
    agentKind: 'claude-code',
    // The server's last-known, which is all a reattach frame has ever carried —
    // named for what it is since POD-3279 so it cannot be mistaken for a report.
    lastKnownGeometry: { cols: 132, rows: 43 },
    binding: {
      transitionId: 't-1',
      machineAccess: 'allowed',
      principal: { kind: 'user', userId: 'user:sole' },
    },
  } as never
}

function ctxFor(sent: Array<{ type: string; resizesBefore: number }>): DaemonContext {
  const ctx = {
    backend: 'host',
    settingsDir: join(tmpdir(), 'podium-sizing-claims-reattach'),
    sessions: testSessions(),
    durableLabelFor: (id: SessionId) => `podium-${id}`,
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 1 },
    observers: {
      trackedState: () => undefined,
      clearSession: () => {},
      initSessionObservers: () => {},
      onResize: () => {},
    },
    sessionCwdTracker: { clear: () => {}, setLaunchCwd: () => {} },
    primeInjector: { reset: () => {} },
    reattachGate: (fn: () => Promise<void>) => fn(),
    sessionBinding: { transition: async () => ({ status: 'unchanged' as const }) },
    tailSeedGate: () => {},
    // Every frame remembers how many resizes had been dispatched when it was
    // sent, which is how the held-resize test proves the ORDER: applied, then
    // reported. A test that only checked both happened would pass on a bind that
    // announced a size the pty had not been given yet.
    send: (m: { type: string }) => sent.push({ ...m, resizesBefore: stub.state.resizes.length }),
  } as unknown as DaemonContext
  const send = ctx.send
  const terminal = createTerminalRuntime(daemonRuntimeHost(ctx, send), undefined, driverSlotsOver(ctx.sessions))
  ctx.send = (msg) => {
    terminal.observe(msg)
    send(msg)
  }
  ctx.agentRuntime = {
    recoverTerminal: terminal.recoverWithId,
    handleFor: terminal.handleFor,
    has: terminal.has,
    adoptJournalled: async () => ({ found: false }),
  } as unknown as NonNullable<DaemonContext['agentRuntime']>
  return ctx
}

describe('C16 (rev 3): a reattach binds the connection size and never touches the program', () => {
  it('binds BARE when the connection reports no size, and never nudges', async () => {
    reset()
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)

    await sessionHandlers.reattach(ctx, reattachMessage())
    // The handler is dispatched fire-and-forget (`void handleReattach(...)`),
    // so drain the microtask/macrotask queue its awaits are parked on.
    await new Promise((r) => setTimeout(r, 0))

    const bind = sent.find((m) => m.type === 'bind') as BindFrame | undefined
    expect(bind).toBeDefined()
    // `toHaveProperty` rather than a `toBeUndefined` on the value: the field
    // must be ABSENT from the frame, not present and empty.
    expect(bind).not.toHaveProperty('geometry')
    // Nothing reached the program: no resize, no redraw nudge, no Ctrl-L.
    expect(stub.state.resizes).toEqual([])
    expect(stub.state.writes).toBe(0)
    // The attach is SIZE-NEUTRAL: it demands the writer lease and resumes at
    // the tail, and last-known never reaches it as a `cols`/`rows` it could apply.
    expect(stub.state.attachedAt).toHaveLength(1)
    expect(stub.state.attachedAt[0]).toMatchObject({
      label: 'podium-s-sizing-reattach',
      socketPath: '/tmp/podium-sizing-claims-reattach.sock',
      requireLease: true,
      fromSeq: 'tail',
    })
    expect(stub.state.attachedAt[0]).not.toHaveProperty('cols')
    expect(stub.state.attachedAt[0]).not.toHaveProperty('rows')
  })

  it('binds BARE for an adopted abduco session: the attach is size-neutral, last-known is never applied', async () => {
    reset()
    stub.state.holder = 'abduco'
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)

    await sessionHandlers.reattach(ctx, reattachMessage())
    await new Promise((r) => setTimeout(r, 0))

    const bind = sent.find((m) => m.type === 'bind') as BindFrame | undefined
    expect(bind).toBeDefined()
    expect(bind).not.toHaveProperty('geometry')
    expect(stub.state.resizes).toEqual([])
    expect(stub.state.writes).toBe(0)
    // The attach is SIZE-NEUTRAL: last-known reaches it only as
    // no `cols`/`rows` it could apply.
    expect(stub.state.attachedAt).toHaveLength(1)
    expect(stub.state.attachedAt[0]).toMatchObject({
      sizeNeutral: true,
    })
    expect(stub.state.attachedAt[0]).not.toHaveProperty('cols')
    expect(stub.state.attachedAt[0]).not.toHaveProperty('rows')
  })

  it('binds the size the connection read back, and reports it once as the size event', async () => {
    reset()
    stub.state.size = { cols: 120, rows: 37 }
    const sent: Array<{ type: string; resizesBefore: number; geometry?: unknown }> = []
    const ctx = ctxFor(sent)

    await sessionHandlers.reattach(ctx, reattachMessage())
    await new Promise((r) => setTimeout(r, 0))

    const bind = sent.find((m) => m.type === 'bind') as BindFrame | undefined
    // The kernel's size — never the server's last-known (132x43) handed back.
    expect(bind?.geometry).toEqual({ cols: 120, rows: 37 })
    expect(sent.filter((m) => m.type === 'geometryApplied')).toHaveLength(1)
    expect(stub.state.resizes).toEqual([])
  })

  it('an ask that arrived before the reattach was dropped: nothing is dispatched at bind', async () => {
    reset()
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)
    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 200, rows: 60 })

    await sessionHandlers.reattach(ctx, reattachMessage())
    await new Promise((r) => setTimeout(r, 0))

    expect(sent.some((m) => m.type === 'bind')).toBe(true)
    expect(stub.state.resizes).toEqual([])
  })
})

describe('terminal recovery ownership', () => {
  it('recovers an old agent row without a persisted driver request', async () => {
    reset()
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)
    sessionHandlers.reattach(ctx, reattachMessage())
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'bind')).toBe(true))
    expect(ctx.agentRuntime?.handleFor(SESSION)?.binding.family).toBe('terminal')
    // Migration without a flag: a previous-release row carries no requested
    // driver, and the first bind after upgrade still announces one.
    expect(sent.find((m) => m.type === 'bind')).toMatchObject({
      driverId: 'generic-pty',
    })
    expect(stub.state.writes).toBe(0)
  })

  it('reuses a surviving bridge, forwards the observation checkpoint, and does not redraw', async () => {
    reset()
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)
    attachTestTerminal(ctx, SESSION, stub.session as unknown as DurableAttachment)
    ctx.sessions.ensure(SESSION).label = 'podium-s-sizing-reattach'
    const init = vi.spyOn(ctx.observers, 'initSessionObservers')
    const msg = {
      ...(reattachMessage() as object),
      observationGeneration: 8,
      observationBindingVersion: 5,
      observationProviderSessionId: 'native-survivor',
      observationCheckpoint: { retained: 'checkpoint' },
    } as Parameters<typeof sessionHandlers.reattach>[1]
    sessionHandlers.reattach(ctx, msg)
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'bind')).toBe(true))
    expect(init).toHaveBeenCalledWith(msg, stub.session, expect.anything(), { seedOnFrame: false })
    expect(stub.state.attachedAt).toHaveLength(0)
    // No link-B redraw (POD-4723): nothing reaches the surviving program.
    expect(stub.state.writes).toBe(0)
    expect(stub.state.resizes).toEqual([])
    expect((await ctx.agentRuntime!.handleFor(SESSION)!.snapshot()).observerGeneration).toBe(8)
  })

  it('keeps plain terminals independent of the agent runtime', async () => {
    reset()
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)
    ctx.agentRuntime = undefined
    sessionHandlers.reattach(ctx, {
      ...(reattachMessage() as object),
      agentKind: 'shell',
    } as Parameters<typeof sessionHandlers.reattach>[1])
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'bind')).toBe(true))
    // Shells bind driverless by structure: no driverId on the frame, and the
    // agent runtime was never consulted (it is undefined here by construction).
    expect(sent.find((m) => m.type === 'bind')).not.toHaveProperty('driverId')
    expect(stub.state.resizes).toEqual([])
  })

  it('refuses a reattach for a kind with no manifest instead of binding it driverless', async () => {
    reset()
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)
    sessionHandlers.reattach(ctx, {
      ...(reattachMessage() as object),
      agentKind: 'not-a-harness',
    } as unknown as Parameters<typeof sessionHandlers.reattach>[1])
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'reattachFailed')).toBe(true))
    expect(sent.find((m) => m.type === 'reattachFailed')).toMatchObject({
      reason: expect.stringContaining('not-a-harness'),
    })
    expect(sent.some((m) => m.type === 'bind')).toBe(false)
    expect(ctx.agentRuntime?.handleFor(SESSION)).toBeUndefined()
  })

  it('reports missing processes and wrong incarnations without publishing bind', async () => {
    for (const wrongIncarnation of [false, true]) {
      reset()
      const sent: Array<{ type: string; resizesBefore: number }> = []
      const ctx = ctxFor(sent)
      if (wrongIncarnation) ctx.sessions.ensure(SESSION).label = 'podium-other-incarnation'
      else ctx.durable = { ...createDurableProcess(), locate: async () => undefined }
      sessionHandlers.reattach(ctx, reattachMessage())
      await vi.waitFor(() => expect(sent.some((m) => m.type === 'reattachFailed')).toBe(true))
      expect(sent.some((m) => m.type === 'bind')).toBe(false)
      expect(ctx.agentRuntime?.handleFor(SESSION)).toBeUndefined()
      expect(stub.state.writes).toBe(0)
    }
  })
})
