import type { AgentSessionHandle } from '@podium/agent-runtime'
import { asSessionId, type ResumeRef, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { launchServerDriverSession, sessionHandlers, stopSessionProcess } from './session'

const SESSION_ID = asSessionId('claude-reattach-session')
const RESUME: ResumeRef = { kind: 'claude-session', value: 'claude-reattach-ref' }

function handle(sessionId: SessionId, resume: ResumeRef): AgentSessionHandle {
  return {
    binding: {
      sessionId,
      driver: 'claude-sdk',
      family: 'embedded',
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
    geometry: { cols: 80, rows: 24 },
    resume,
    runtimeContract: 'claude-sdk',
    binding: {
      transitionId: `reattach:${sessionId}`,
      machineAccess: 'allowed',
      sessionAccess: 'allowed',
      principal: { kind: 'system' },
      adopt: { ownerUserId: 'user:owner' },
    },
  } as never
}

function world(input: {
  existing?: AgentSessionHandle
  adopt: (binding: unknown) => Promise<AgentSessionHandle>
  resume: (ref: ResumeRef, spec: unknown, sessionId?: SessionId) => Promise<AgentSessionHandle>
}) {
  const sent: DaemonMessage[] = []
  const adopt = vi.fn(input.adopt)
  const resume = vi.fn(input.resume)
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    machineId: 'claude-test-machine',
    sessionBinding: {
      transition: vi.fn(async () => ({
        status: 'applied',
        binding: { transitionHistory: [] },
      })),
    },
    agentRuntime: {
      handleFor: vi.fn(() => input.existing),
      adopt,
      resume,
    },
  } as unknown as DaemonContext
  return { ctx, sent, adopt, resume }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Claude SDK reattach control', () => {
  it('adopts the surviving handle without minting a replacement conversation', async () => {
    vi.stubEnv('PODIUM_CLAUDE_SDK_TOS_ACCEPTED', '1')
    const surviving = handle(SESSION_ID, RESUME)
    const w = world({
      existing: surviving,
      adopt: async () => surviving,
      resume: async () => {
        throw new Error('process-gone resume must not run for a survivor')
      },
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, RESUME))
    await vi.waitFor(() => expect(w.adopt).toHaveBeenCalledTimes(1))

    expect(w.adopt).toHaveBeenCalledWith(surviving.binding)
    expect(w.resume).not.toHaveBeenCalled()
    expect(w.sent).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        sessionId: SESSION_ID,
        runtimeContract: true,
        driverId: 'claude-sdk',
      }),
    )
    expect(w.sent).toContainEqual(
      expect.objectContaining({ type: 'sessionResumeRef', sessionId: SESSION_ID, resume: RESUME }),
    )
    expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(false)
  })

  it('resumes with the exact id and ref after the daemon process is gone', async () => {
    vi.stubEnv('PODIUM_CLAUDE_SDK_TOS_ACCEPTED', '1')
    const resumed = handle(SESSION_ID, RESUME)
    const w = world({
      adopt: async () => {
        throw new Error('claude-sdk: no exact surviving process')
      },
      resume: async (ref, spec, sessionId) => {
        expect(ref).toEqual(RESUME)
        expect(spec).toMatchObject({ harness: 'claude-code', workdir: '/project' })
        expect(sessionId).toBe(SESSION_ID)
        return resumed
      },
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, RESUME))
    await vi.waitFor(() => expect(w.resume).toHaveBeenCalledTimes(1))

    expect(w.adopt).toHaveBeenCalledTimes(1)
    expect(w.resume).toHaveBeenCalledWith(RESUME, expect.any(Object), SESSION_ID)
    expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(false)
  })

  it('refuses reattach unless the exact operator acknowledgement is present', async () => {
    vi.stubEnv('PODIUM_CLAUDE_SDK_TOS_ACCEPTED', 'true')
    const w = world({
      adopt: async () => {
        throw new Error('must not call the SDK')
      },
      resume: async () => {
        throw new Error('must not call the SDK')
      },
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, RESUME))
    await vi.waitFor(() =>
      expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(true),
    )

    expect(w.adopt).not.toHaveBeenCalled()
    expect(w.resume).not.toHaveBeenCalled()
    expect(w.sent.at(-1)).toMatchObject({
      type: 'reattachFailed',
      sessionId: SESSION_ID,
      reason: expect.stringContaining('PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1'),
    })
  })
})
describe('Claude SDK embedded teardown', () => {
  it('ends an embedded handle from the generic hibernate/kill choke point', async () => {
    const kill = vi.fn(async () => {})
    const sent: DaemonMessage[] = []
    const runtimeHandle = { ...handle(SESSION_ID, RESUME), kill }
    const ctx = {
      backend: 'none',
      settingsDir: '/nonexistent/podium-test-settings',
      bridges: new Map(),
      pendingResizes: new Map(),
      durableLabels: new Map(),
      durableLabelFor: (sessionId: SessionId) => `podium-${sessionId}`,
      observers: { clearSession: vi.fn() },
      outputScheduler: { remove: vi.fn() },
      portableStateFence: { runSync: (fn: () => void) => fn() },
      agentRuntime: {
        handleFor: vi.fn(() => runtimeHandle),
        serverHandleFor: vi.fn(() => undefined),
        journalledServerProcess: vi.fn(() => undefined),
        clearTerminal: vi.fn(),
      },
      instanceUuid: undefined,
      send: (message: DaemonMessage) => sent.push(message),
    } as unknown as DaemonContext

    stopSessionProcess(ctx, { sessionId: SESSION_ID })
    await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1))
    expect(sent).toEqual([])
  })
})

describe('Claude SDK spawn resume control', () => {
  it('passes the exact Podium id and Claude ref to resume instead of create', async () => {
    vi.stubEnv('PODIUM_CLAUDE_SDK_TOS_ACCEPTED', '1')
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
      runtimeContract: 'claude-sdk',
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
