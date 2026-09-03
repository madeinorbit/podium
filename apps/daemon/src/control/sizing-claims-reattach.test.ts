/**
 * SIZING PLAN ASSUMPTION TESTS — C16, daemon half (POD-3235, SPEC-0b.md rev 2;
 * rewritten for POD-3279's rule 1 rev 4).
 *
 * Its own file because it must mock `@podium/pty` at module scope: the claim is
 * about what the reattach handler does AROUND the durable attach, so the attach
 * itself is stubbed and the real handler runs. The abduco half of C16
 * (`repaintOnAttach` defaulting to true) is executed for real against a vendored
 * abduco in `packages/pty/src/abduco-winsize.integration.test.ts`.
 *
 * WHAT CHANGED AT STAGE 3: the bind used to carry `msg.geometry` back, which was
 * the server's own last-known returned to it as a daemon report. A size-neutral
 * attach applies nothing, so the bind now carries NO geometry — unless the
 * daemon was holding a resize for this session, which it dispatches at bind and
 * may therefore report. The redraw half of the original claim is unchanged.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import type { AgentSession } from '@podium/pty'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'

const SESSION = asSessionId('s-sizing-reattach')

const stub = vi.hoisted(() => {
  const state = { redraws: 0, resizes: [] as Array<[number, number]>, attachedAt: [] as unknown[] }
  const session = {
    pid: 4321,
    onFrame: () => () => {},
    onTitle: () => () => {},
    onExit: () => () => {},
    write: () => {},
    writeBytes: () => {},
    resize: (cols: number, rows: number) => {
      state.resizes.push([cols, rows])
    },
    redraw: () => {
      state.redraws += 1
    },
    geometry: () => ({ cols: 80, rows: 24 }),
    dispose: () => {},
  }
  return { state, session }
})

vi.mock('@podium/pty', () => ({
  abducoHasSession: async () => true,
  abducoSocketPath: () => '/tmp/podium-sizing-claims-reattach.sock',
  attachAbducoAgent: (opts: unknown) => {
    stub.state.attachedAt.push(opts)
    return stub.session
  },
  attachTmuxAgent: () => stub.session,
  killAbducoSession: async () => {},
  killTmuxServer: async () => {},
  reapStaleAbducoBindTemps: () => {},
  spawnAbducoAgent: async () => stub.session,
  spawnAgent: () => stub.session,
  spawnTmuxAgent: () => stub.session,
  tmuxHasSession: async () => false,
  waitForAbducoSocket: async () => '/tmp/podium-sizing-claims-reattach.sock',
}))

const { sessionHandlers } = await import('./session')

type BindFrame = { type: 'bind'; geometry?: { cols: number; rows: number } }

/** The module-scope stub is shared across tests; each one starts from zero. */
function reset(): void {
  stub.state.redraws = 0
  stub.state.resizes.length = 0
  stub.state.attachedAt.length = 0
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
  return {
    backend: 'abduco',
    settingsDir: join(tmpdir(), 'podium-sizing-claims-reattach'),
    bridges: new Map<SessionId, AgentSession>(),
    pendingResizes: new Map<SessionId, { cols: number; rows: number }>(),
    durableLabels: new Map<SessionId, string>(),
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
    outputScheduler: { enqueue: () => {}, remove: () => {}, priorityOf: () => 1 },
    observers: { clearSession: () => {}, initSessionObservers: () => {}, onResize: () => {} },
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
}

describe('C16: the daemon nudges the reattached session once more after bind', () => {
  it('binds with NO geometry, then calls redraw() on the attached session', async () => {
    reset()
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)

    await sessionHandlers.reattach(ctx, reattachMessage())
    // The handler is dispatched fire-and-forget (`void handleReattach(...)`),
    // so drain the microtask/macrotask queue its awaits are parked on.
    await new Promise((r) => setTimeout(r, 0))

    const bind = sent.find((m) => m.type === 'bind') as BindFrame | undefined
    expect(bind).toBeDefined()
    // THE WHOLE POINT (POD-3279). This attach applied no size to anything, so the
    // bind states nothing about the grid. `toHaveProperty` rather than a
    // `toBeUndefined` on the value: the field must be ABSENT from the frame, not
    // present and empty — an explicit `geometry: undefined` would encode to the
    // same bytes here but would be a different statement in the type.
    expect(bind).not.toHaveProperty('geometry')
    // And nothing was resized on the way: the daemon held no pending resize, so
    // there was nothing to apply and nothing to report.
    expect(stub.state.resizes).toEqual([])

    // attachAbducoAgent's own repaintOnAttach fires before the bridge is wired,
    // so that first nudge can be lost — hence exactly one more, here, after bind.
    expect(stub.state.redraws).toBe(1)
    // The attach still carries the server's last-known to the client rather than
    // a value read back from the master (C14), and it is SIZE-NEUTRAL (stage 2),
    // which is exactly why the bind above can report nothing.
    expect(stub.state.attachedAt).toHaveLength(1)
    expect(stub.state.attachedAt[0]).toMatchObject({
      cols: 132,
      rows: 43,
      sizeNeutral: true,
    })
  })

  it('binds at a HELD resize, dispatched to the pty before the bind goes out', async () => {
    reset()
    const sent: Array<{ type: string; resizesBefore: number }> = []
    const ctx = ctxFor(sent)
    // A viewer asked for a size while this session had no bridge — the daemon
    // parked it. Binding is where it gets applied, so binding is where the daemon
    // has something true to report.
    ctx.pendingResizes.set(SESSION, { cols: 200, rows: 60 })

    await sessionHandlers.reattach(ctx, reattachMessage())
    await new Promise((r) => setTimeout(r, 0))

    const bind = sent.find((m) => m.type === 'bind') as
      | (BindFrame & { resizesBefore: number })
      | undefined
    expect(bind).toBeDefined()
    expect(bind?.geometry).toEqual({ cols: 200, rows: 60 })
    // Reported because APPLIED, and applied FIRST: the pty took the resize before
    // the server was told about it, so the report can never describe a size the
    // child has not been given.
    expect(stub.state.resizes).toEqual([[200, 60]])
    expect(bind?.resizesBefore).toBe(1)
    // The held resize is consumed, not left to fire again on the next bind.
    expect(ctx.pendingResizes.has(SESSION)).toBe(false)
  })
})
