/**
 * SIZING PLAN ASSUMPTION TESTS — C16, daemon half (POD-3235, SPEC-0b.md rev 2).
 *
 * Its own file because it must mock `@podium/pty` at module scope: the claim is
 * about what the reattach handler does AROUND the durable attach, so the attach
 * itself is stubbed and the real handler runs. The abduco half of C16
 * (`repaintOnAttach` defaulting to true) is executed for real against a vendored
 * abduco in `packages/pty/src/abduco-winsize.integration.test.ts`.
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

function ctxFor(sent: Array<{ type: string }>): DaemonContext {
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
    send: (m: { type: string }) => sent.push(m),
  } as unknown as DaemonContext
}

describe('C16: the daemon nudges the reattached session once more after bind', () => {
  it('binds at the geometry it reports, then calls redraw() on the attached session', async () => {
    const sent: Array<{ type: string }> = []
    const ctx = ctxFor(sent)

    await sessionHandlers.reattach(ctx, {
      type: 'reattach',
      sessionId: SESSION,
      durableLabel: 'podium-s-sizing-reattach',
      cwd: '/w',
      agentKind: 'claude-code',
      geometry: { cols: 132, rows: 43 },
      binding: {
        transitionId: 't-1',
        machineAccess: 'allowed',
        principal: { kind: 'user', userId: 'user:sole' },
      },
    } as never)
    // The handler is dispatched fire-and-forget (`void handleReattach(...)`),
    // so drain the microtask/macrotask queue its awaits are parked on.
    await new Promise((r) => setTimeout(r, 0))

    const bind = sent.find((m) => m.type === 'bind') as
      | { type: 'bind'; geometry: { cols: number; rows: number } }
      | undefined
    expect(bind).toBeDefined()
    expect(bind?.geometry).toEqual({ cols: 132, rows: 43 })

    // attachAbducoAgent's own repaintOnAttach fires before the bridge is wired,
    // so that first nudge can be lost — hence exactly one more, here, after bind.
    expect(stub.state.redraws).toBe(1)
    // The attach carried the requested size to the client, not a value read back
    // from the master (see C14).
    expect(stub.state.attachedAt).toHaveLength(1)
    expect(stub.state.attachedAt[0]).toMatchObject({ cols: 132, rows: 43 })
  })
})
