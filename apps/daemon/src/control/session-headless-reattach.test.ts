import type { AgentSessionHandle } from '@podium/agent-runtime'
import { asSessionId, type ResumeRef, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { sessionHandlers } from './session'

const SESSION_ID = asSessionId('headless-reattach-session')
const ADOPT_ERROR = 'headless: no exact surviving process'
const RESUME_ERROR = 'headless-resume-gone'
const RESUME: ResumeRef = { kind: 'headless-session', value: 'headless-reattach-ref' }

function headlessHandle(sessionId: SessionId, resume: ResumeRef | null): AgentSessionHandle {
  return {
    binding: {
      sessionId,
      driver: 'headless',
      family: 'server',
      harness: 'codex',
      workdir: '/project',
      resume,
      process: { key: `podium-${sessionId}` },
      bindingVersion: 1,
    },
    state: async () => ({
      phase: 'idle',
      since: '2026-08-27T00:00:00.000Z',
      nativeSubagentCount: 0,
    }),
  } as unknown as AgentSessionHandle
}

function reattachMessage(
  sessionId: SessionId,
  input: { resume?: ResumeRef; runtimeContract?: string } = {},
): never {
  const { resume, runtimeContract = 'headless' } = input
  return {
    type: 'reattach',
    sessionId,
    durableLabel: `podium-${sessionId}`,
    agentKind: 'codex',
    cwd: '/project',
    lastKnownGeometry: { cols: 80, rows: 24 },
    ...(resume ? { resume } : {}),
    ...(runtimeContract === undefined ? {} : { runtimeContract }),
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
  const recoverTerminal = vi.fn(async () => {
    throw new Error('PTY path must not claim a headless session')
  })
  const adoptJournalled = vi.fn(async () => ({ found: false as const }))
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    machineId: 'headless-test-machine',
    bridges: new Map(),
    durableLabels: new Map(),
    durableLabelFor: (sessionId: SessionId) => `podium-${sessionId}`,
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
      adoptJournalled,
      recoverTerminal,
    },
  } as unknown as DaemonContext
  return { ctx, sent, adopt, resume, recoverTerminal }
}

describe('Headless reattach control', () => {
  it('adopts on the exact durable label instead of falling through to a PTY', async () => {
    const adopted = headlessHandle(SESSION_ID, null)
    const w = world({
      adopt: async (binding) => {
        expect(binding).toMatchObject({
          sessionId: SESSION_ID,
          driver: 'headless',
          process: { key: `podium-${SESSION_ID}` },
        })
        return adopted
      },
      resume: async () => {
        throw new Error('adopt success must not reach resume')
      },
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID))
    await vi.waitFor(() => expect(w.adopt).toHaveBeenCalledTimes(1))

    expect(w.adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        driver: 'headless',
        process: { key: `podium-${SESSION_ID}` },
      }),
    )
    expect(w.resume).not.toHaveBeenCalled()
    expect(w.recoverTerminal).not.toHaveBeenCalled()
    expect(w.sent).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        sessionId: SESSION_ID,
        runtimeContract: true,
        driverId: 'headless',
      }),
    )
    expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(false)
  })

  it('falls back to resume with the exact id and ref when adopt finds no survivor', async () => {
    const resumed = headlessHandle(SESSION_ID, RESUME)
    const w = world({
      adopt: async () => {
        throw new Error(ADOPT_ERROR)
      },
      resume: async (ref, spec, sessionId) => {
        expect(ref).toEqual(RESUME)
        expect(spec).toMatchObject({ harness: 'codex', workdir: '/project' })
        expect(sessionId).toBe(SESSION_ID)
        return resumed
      },
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, { resume: RESUME }))
    await vi.waitFor(() => expect(w.resume).toHaveBeenCalledTimes(1))

    expect(w.adopt).toHaveBeenCalledTimes(1)
    expect(w.resume).toHaveBeenCalledWith(RESUME, expect.any(Object), SESSION_ID)
    expect(w.recoverTerminal).not.toHaveBeenCalled()
    expect(w.sent).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        sessionId: SESSION_ID,
        runtimeContract: true,
        driverId: 'headless',
      }),
    )
    expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(false)
  })

  it('fails explicitly instead of landing on a PTY when adopt and resume both fail', async () => {
    const w = world({
      adopt: async () => {
        throw new Error(ADOPT_ERROR)
      },
      resume: async () => {
        throw new Error(RESUME_ERROR)
      },
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, { resume: RESUME }))
    await vi.waitFor(() =>
      expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(true),
    )

    expect(w.adopt).toHaveBeenCalledTimes(1)
    expect(w.resume).toHaveBeenCalledTimes(1)
    expect(w.recoverTerminal).not.toHaveBeenCalled()
    const failure = w.sent.find((message) => message.type === 'reattachFailed')
    expect(failure).toMatchObject({ type: 'reattachFailed', sessionId: SESSION_ID })
    expect((failure as { reason: string }).reason).toContain(RESUME_ERROR)
    expect((failure as { reason: string }).reason).not.toContain('has no recoverable binding')
    expect(w.sent.some((message) => message.type === 'bind')).toBe(false)
  })

  it('rebinds a surviving headless handle with no requested contract instead of a PTY', async () => {
    const surviving = headlessHandle(SESSION_ID, null)
    const w = world({
      existing: surviving,
      adopt: async () => surviving,
      resume: async () => {
        throw new Error('survivor adopt must not reach resume')
      },
    })

    sessionHandlers.reattach(w.ctx, reattachMessage(SESSION_ID, { runtimeContract: undefined }))
    await vi.waitFor(() => expect(w.adopt).toHaveBeenCalledTimes(1))

    expect(w.adopt).toHaveBeenCalledWith(surviving.binding)
    expect(w.resume).not.toHaveBeenCalled()
    expect(w.recoverTerminal).not.toHaveBeenCalled()
    expect(w.sent).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        sessionId: SESSION_ID,
        runtimeContract: true,
        driverId: 'headless',
      }),
    )
    expect(w.sent.some((message) => message.type === 'reattachFailed')).toBe(false)
  })
})
