import { EngineBindUnrecoverable } from '@podium/harness/driver/host'
import { asSessionId, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { launchServerDriverSession, sessionHandlers } from './session'
import { testSessions } from '../session/testing.js'

vi.mock('../runtime/server-reap', () => ({ beginServerDriverReap: vi.fn(async () => false) }))
import { beginServerDriverReap } from '../runtime/server-reap'

const LAUNCH_SESSION = asSessionId('bind-failure-launch')
const ADOPT_SESSION = asSessionId('bind-failure-adopt')

function launchWorld(create: (spec: unknown, sessionId: SessionId) => Promise<unknown>) {
  const sent: DaemonMessage[] = []
  const sessions = testSessions()
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    harnessLoginState: () => 'in',
    sessions,
    agentRuntime: {
      resolveDriver: () => ({
        ok: true,
        driverId: 'codex-app-server',
        capabilities: { placement: 'dedicated' },
      }),
      serverHandleFor: () => undefined,
      handleFor: () => undefined,
      adoptJournalled: async () => ({ found: false }),
      create,
    },
  } as unknown as DaemonContext
  return { ctx, sent, sessions }
}

const drivableProbe = async () => ({ drivable: true as const })

describe('§4.8 bind failure on the launch path (POD-4490)', () => {
  it('a kept engine surfaces spawnError and is recorded on the DaemonSession', async () => {
    const failure = new EngineBindUnrecoverable(
      LAUNCH_SESSION,
      'launch',
      'unix:///tmp/kept-launch.sock',
      new Error('listener silent'),
    )
    const { ctx, sent, sessions } = launchWorld(async () => {
      throw failure
    })

    const result = await launchServerDriverSession(
      ctx,
      {
        type: 'spawn',
        sessionId: LAUNCH_SESSION,
        agentKind: 'codex',
        cwd: '/project',
        geometry: { cols: 80, rows: 24 },
        requestedDriverId: 'codex-app-server',
      } as never,
      drivableProbe as never,
    )

    expect(result).toEqual({ handled: true })
    const spawnError = sent.find((msg) => msg.type === 'spawnError')
    expect(spawnError).toMatchObject({ type: 'spawnError', sessionId: LAUNCH_SESSION })
    expect((spawnError as { message: string }).message).toContain('did not bind during launch')
    expect((spawnError as { message: string }).message).toContain('unix:///tmp/kept-launch.sock')
    // The survivor is recorded from the error identity for a later adopt-or-reap pass.
    expect(sessions.get(LAUNCH_SESSION)?.keptEngine).toMatchObject({
      address: 'unix:///tmp/kept-launch.sock',
      during: 'launch',
    })
    // No generic second error beside the owned one.
    expect(sent.filter((msg) => msg.type === 'spawnError')).toHaveLength(1)
    // Cold launch took custody of nothing: no abandonment frame, only the error.
    expect(sent.some((msg) => msg.type === 'runtimeQueueDrainAbandoned')).toBe(false)
  })
})

function reattachWorld(adoptJournalled: () => Promise<unknown>) {
  const sent: DaemonMessage[] = []
  const sessions = testSessions()
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    machineId: 'bind-failure-test-machine',
    sessions,
    durableLabelFor: (sessionId: SessionId) => `podium-${sessionId}`,
    sessionBinding: {
      transition: vi.fn(async () => ({ status: 'applied', binding: { transitionHistory: [] } })),
    },
    agentRuntime: {
      handleFor: vi.fn(() => undefined),
      adoptJournalled,
    },
  } as unknown as DaemonContext
  return { ctx, sent, sessions }
}

describe('§4.8 bind failure on the reattach path (POD-4490)', () => {
  it('a kept engine is NOT reaped: survivor recorded, failure surfaced with the bind message', async () => {
    // The realistic adopt failure: the journalled server was gone, the
    // fallback fresh child would not bind, and the family kept it. `during`
    // names the engine operation (a fresh launch), so the surfaced frame is
    // the fresh one — the fresh/adopt split engine-supervision.ts documents.
    const failure = new EngineBindUnrecoverable(
      ADOPT_SESSION,
      'launch',
      'unix:///tmp/kept-adopt.sock',
      new Error('fresh child did not bind'),
      'kept-secret',
    )
    const { ctx, sent, sessions } = reattachWorld(async () => ({
      found: true,
      what: 'codex app-server',
      workdir: '/project',
      reason: failure.message,
      bindFailure: failure,
    }))

    sessionHandlers.reattach(ctx, {
      type: 'reattach',
      sessionId: ADOPT_SESSION,
      durableLabel: `podium-${ADOPT_SESSION}`,
      agentKind: 'codex',
      cwd: '/project',
      lastKnownGeometry: { cols: 80, rows: 24 },
      binding: {
        transitionId: `reattach:${ADOPT_SESSION}`,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'system' },
      },
    } as never)
    await vi.waitFor(() =>
      expect(sent.some((msg) => msg.type === 'spawnError')).toBe(true),
    )

    const surfaced = sent.find((msg) => msg.type === 'spawnError')
    expect(surfaced).toMatchObject({ type: 'spawnError', sessionId: ADOPT_SESSION })
    expect((surfaced as { message: string }).message).toContain('did not bind')
    // KEPT means kept: the failed-adoption reap must not run for a bind failure.
    expect(beginServerDriverReap).not.toHaveBeenCalled()
    expect(sessions.get(ADOPT_SESSION)?.keptEngine).toMatchObject({
      address: 'unix:///tmp/kept-adopt.sock',
    })
    expect(JSON.stringify(sent)).not.toContain('kept-secret')
  })

  it('an adopt-phase bind failure surfaces reattachFailed', async () => {
    const sessionId = asSessionId('bind-failure-adopt-phase')
    const failure = new EngineBindUnrecoverable(
      sessionId,
      'adopt',
      'unix:///tmp/kept-adopt-phase.sock',
      new Error('rebind refused the protocol'),
    )
    const { ctx, sent } = reattachWorld(async () => ({
      found: true,
      what: 'codex app-server',
      workdir: '/project',
      reason: failure.message,
      bindFailure: failure,
    }))

    sessionHandlers.reattach(ctx, {
      type: 'reattach',
      sessionId,
      durableLabel: `podium-${sessionId}`,
      agentKind: 'codex',
      cwd: '/project',
      lastKnownGeometry: { cols: 80, rows: 24 },
      binding: {
        transitionId: `reattach:${sessionId}`,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'system' },
      },
    } as never)
    await vi.waitFor(() =>
      expect(sent.some((msg) => msg.type === 'reattachFailed')).toBe(true),
    )

    expect(beginServerDriverReap).not.toHaveBeenCalled()
  })
})
