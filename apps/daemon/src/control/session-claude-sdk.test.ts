import type { AgentSessionHandle } from '@podium/harness/driver/host'
import { asSessionId, type ResumeRef, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { configureFieldsForDriver } from '@podium/harness/driver/host'
import type { DaemonContext } from './context'
import { launchServerDriverSession, sessionHandlers, stopSessionProcess } from './session'
import { testSessions } from '../session/testing.js'

const SESSION_ID = asSessionId('claude-reattach-session')
const RESUME: ResumeRef = { kind: 'claude-session', value: 'claude-reattach-ref' }

function handle(sessionId: SessionId, resume: ResumeRef): AgentSessionHandle {
  return {
    binding: {
      sessionId,
      driver: 'claude-sdk',
      family: 'server',
      harness: 'claude-code',
      workdir: '/project',
      resume,
      process: { key: `claude-sdk:${sessionId}` },
      bindingVersion: 1,
    },
    state: async () => ({
      phase: 'idle',
      since: '2026-08-27T00:00:00.000Z',
      nativeSubagentCount: 0,
    }),
  } as unknown as AgentSessionHandle
}

function reattachMessage(sessionId: SessionId, resume: ResumeRef): never {
  return {
    type: 'reattach',
    sessionId,
    durableLabel: `podium-${sessionId}`,
    agentKind: 'claude-code',
    cwd: '/project',
    lastKnownGeometry: { cols: 80, rows: 24 },
    resume,
    requestedDriverId: 'claude-sdk',
    binding: {
      transitionId: `reattach:${sessionId}`,
      machineAccess: 'allowed',
      sessionAccess: 'allowed',
      principal: { kind: 'system' },
      adopt: { ownerUserId: 'user:owner' },
    },
  } as never
}

/**
 * The machine root as the generic server arm sees it (POD-4612): the Claude
 * engine answers `adoptJournalled` like codex, opencode and grok — there is no
 * Claude-specific adopt or resume verb left for the reattach path to call.
 */
function world(input: {
  adoptJournalled: (
    sessionId: SessionId,
    expect?: { resume?: ResumeRef },
  ) => Promise<unknown>
}) {
  const sent: DaemonMessage[] = []
  const adoptJournalled = vi.fn(input.adoptJournalled)
  const adopt = vi.fn()
  const resume = vi.fn()
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    machineId: 'claude-test-machine',
    sessions: testSessions(),
    sessionBinding: {
      transition: vi.fn(async () => ({
        status: 'applied',
        binding: { transitionHistory: [] },
      })),
    },
    agentRuntime: {
      handleFor: vi.fn(() => undefined),
      adoptJournalled,
      adopt,
      resume,
    },
  } as unknown as DaemonContext
  return { ctx, sent, adoptJournalled, adopt, resume }
}

describe('Claude SDK reattach control', () => {
  it('adopts the surviving handle through the generic server arm', async () => {
    const surviving = handle(SESSION_ID, RESUME)
    const w = world({
      adoptJournalled: async () => ({
        found: true,
        what: 'claude --input-format stream-json (streaming engine)',
        workdir: '/project',
        handle: surviving,
      }),
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, RESUME))
    await vi.waitFor(() => expect(w.adoptJournalled).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(w.sent.some((message) => message.type === 'bind')).toBe(true),
    )

    // The row's conversation travels with the request, so the arm can refuse a
    // journal naming a different one before adopting anything.
    expect(w.adoptJournalled).toHaveBeenCalledWith(SESSION_ID, { resume: RESUME })
    expect(w.adopt).not.toHaveBeenCalled()
    expect(w.resume).not.toHaveBeenCalled()
    expect(w.sent).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        sessionId: SESSION_ID,
        driverId: 'claude-sdk',
        configureFields: [...configureFieldsForDriver('claude-sdk')],
        attachKinds: [],
      }),
    )
    // ADOPTING A SURVIVOR APPLIES NO SIZE (POD-3279), so its bind carries none.
    // `objectContaining` above cannot see an extra field, which is exactly why
    // the absence is asserted separately here.
    expect(w.sent.find((message) => message.type === 'bind')).not.toHaveProperty('geometry')
    expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(false)
  })

  it('refuses, without adopting, a journal that names a different conversation', async () => {
    const w = world({
      adoptJournalled: async () => ({
        found: true,
        what: 'claude --input-format stream-json (streaming engine)',
        workdir: '/project',
        conversationMismatch: 'the journal continues a different conversation',
      }),
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, RESUME))
    await vi.waitFor(() =>
      expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(true),
    )

    expect(w.sent).toContainEqual({
      type: 'reattachFailed',
      sessionId: SESSION_ID,
      reason: 'the journal continues a different conversation',
    })
    expect(w.sent.some((message) => message.type === 'bind')).toBe(false)
  })

  it('answers retry, not a PTY, when nothing journals the session', async () => {
    // Process gone AND no journal: the server-family answer is a reattach
    // failure the server retries as a spawn with the resume ref — which the
    // launch path continues through `runtime.resume` (see below).
    const w = world({ adoptJournalled: async () => ({ found: false }) })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, RESUME))
    await vi.waitFor(() =>
      expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(true),
    )

    expect(w.sent).toContainEqual({
      type: 'reattachFailed',
      sessionId: SESSION_ID,
      reason: "runtime driver 'claude-sdk' has no recoverable binding; retry this session",
    })
    expect(w.resume).not.toHaveBeenCalled()
  })
})
describe('Claude SDK server-family teardown', () => {
  it('ends the Claude handle through the generic server reap', async () => {
    const stop = vi.fn(async () => {})
    const kill = vi.fn(async () => {})
    const sent: DaemonMessage[] = []
    const base = handle(SESSION_ID, RESUME)
    // The binding a held engine reports since POD-4612: its durable label and
    // the pid this daemon holds — what the generic reap measures.
    const runtimeHandle = {
      ...base,
      binding: { ...base.binding, process: { key: 'podium-cl-claude-reattach-session', pid: 4242 } },
      stop,
      kill,
    }
    const ctx = {
      backend: 'none',
      settingsDir: '/nonexistent/podium-test-settings',
      sessions: testSessions(),
      durableLabelFor: (sessionId: SessionId) => `podium-${sessionId}`,
      observers: { clearSession: vi.fn() },
      outputScheduler: { remove: vi.fn() },
      portableStateFence: { runSync: (fn: () => void) => fn() },
      agentRuntime: {
        handleFor: vi.fn(() => runtimeHandle),
        serverHandleFor: vi.fn(() => runtimeHandle),
        journalledServerProcess: vi.fn(() => undefined),
        clearTerminal: vi.fn(),
      },
      serverReapIo: {
        pidAlive: () => false,
        signal: vi.fn(),
        pidInUnit: () => false,
        probeOpencode: async () => false,
        canScope: async () => false,
        runSystemctl: vi.fn(async () => {}),
        sleep: async () => {},
      },
      instanceUuid: undefined,
      send: (message: DaemonMessage) => sent.push(message),
    } as unknown as DaemonContext

    await expect(stopSessionProcess(ctx, { sessionId: SESSION_ID })).resolves.toBe(true)
    // A generic kill parks: the server reap's verb is `stop`, exactly once —
    // no second, Claude-specific ending beside it — and the receipt is a
    // MEASURED kill of the engine's own identity, never an unmeasured one the
    // server would answer by reviving the row.
    expect(stop).toHaveBeenCalledTimes(1)
    expect(kill).not.toHaveBeenCalled()
    expect(sent).toContainEqual({
      type: 'sessionKillResult',
      sessionId: SESSION_ID,
      durableLabel: 'podium-cl-claude-reattach-session',
      killed: true,
    })
  })
})

describe('Claude stream engine spawn selection', () => {
  it('launches the stream engine for an explicit logged-in Claude spawn', async () => {
    const created = handle(SESSION_ID, RESUME)
    const send = vi.fn()
    const create = vi.fn(async () => created)
    const resume = vi.fn(async () => {
      throw new Error('fresh subscription spawn must not resume')
    })
    const ctx = {
      send,
      harnessLoginState: () => 'in',
      agentRuntime: {
        resolveDriver: vi.fn(() => ({
          ok: true,
          driverId: 'claude-sdk',
          capabilities: { placement: 'dedicated' },
        })),
        serverHandleFor: vi.fn(() => undefined),
        adoptJournalled: vi.fn(async () => ({ found: false })),
        resumesAtLaunch: vi.fn(() => true),
        create,
        resume,
        handleFor: vi.fn(() => undefined),
      },
    } as unknown as DaemonContext
    const message = {
      type: 'spawn',
      sessionId: SESSION_ID,
      agentKind: 'claude-code',
      cwd: '/project',
      geometry: { cols: 80, rows: 24 },
      requestedDriverId: 'claude-sdk',
    } as never

    await expect(
      launchServerDriverSession(ctx, message, async () => ({ drivable: true })),
    ).resolves.toEqual({ handled: true })
    expect(create).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })

  it('keeps an ordinary Claude spawn on the PTY path', async () => {
    const send = vi.fn()
    const create = vi.fn(async () => {
      throw new Error('SDK must not launch')
    })
    const ctx = {
      send,
      harnessLoginState: () => 'in',
      agentRuntime: {
        resolveDriver: vi.fn(() => {
          throw new Error('resolve must not run without an explicit runtime request')
        }),
        create,
        resume: vi.fn(),
        handleFor: vi.fn(() => undefined),
      },
    } as unknown as DaemonContext
    const message = {
      type: 'spawn',
      sessionId: SESSION_ID,
      agentKind: 'claude-code',
      cwd: '/project',
      geometry: { cols: 80, rows: 24 },
    } as never

    await expect(
      launchServerDriverSession(ctx, message, async () => ({ drivable: true })),
    ).resolves.toEqual({ handled: false })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('Claude SDK spawn resume control', () => {
  it('passes the exact Podium id and Claude ref to resume instead of create', async () => {
    const resumed = handle(SESSION_ID, RESUME)
    const send = vi.fn()
    const create = vi.fn(async () => {
      throw new Error('spawn-resume must not create a new conversation')
    })
    const resume = vi.fn(async () => resumed)
    const ctx = {
      send,
      harnessLoginState: () => 'in',
      agentRuntime: {
        resolveDriver: vi.fn(() => ({
          ok: true,
          driverId: 'claude-sdk',
          capabilities: { placement: 'dedicated' },
        })),
        serverHandleFor: vi.fn(() => undefined),
        // No journal: nothing survived to adopt, so the ref alone continues it.
        adoptJournalled: vi.fn(async () => ({ found: false })),
        resumesAtLaunch: vi.fn(() => true),
        create,
        resume,
        handleFor: vi.fn(() => undefined),
      },
    } as unknown as DaemonContext
    const message = {
      type: 'spawn',
      sessionId: SESSION_ID,
      agentKind: 'claude-code',
      cwd: '/project',
      geometry: { cols: 80, rows: 24 },
      resume: RESUME,
      requestedDriverId: 'claude-sdk',
    } as never

    await expect(
      launchServerDriverSession(ctx, message, async () => ({ drivable: true })),
    ).resolves.toEqual({
      handled: true,
    })
    expect(create).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledWith(
      RESUME,
      expect.objectContaining({ harness: 'claude-code' }),
      SESSION_ID,
    )
    expect(send).toHaveBeenCalledWith({
      type: 'driverSelected',
      sessionId: SESSION_ID,
      driverId: 'claude-sdk',
    })
  })
})
