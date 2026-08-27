import type { HeadlessTurnHandle, HeadlessTurnSpec } from '../headless-drivers'
import type { ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { runClaudeSdkChildTurn } from '../claude-sdk-client'
import type { TerminalRuntimeHost } from './terminal-driver'
import { createDaemonClaudeSdkRuntime } from './claude-sdk-driver'
import { createDaemonMachineRuntime } from './machine-runtime'

vi.mock('../claude-sdk-client', () => ({
  runClaudeSdkChildTurn: vi.fn(),
}))

const SESSION_ID = 'claude-adapter-session' as SessionId
const RESUME: ResumeRef = { kind: 'claude-session', value: 'claude-native-thread' }

const WITNESS: TranscriptItem[] = [
  {
    id: 'witness-user',
    role: 'user',
    text: 'before the daemon restart',
    ts: '2026-08-27T00:00:00.000Z',
  },
  {
    id: 'witness-assistant',
    role: 'assistant',
    text: 'the earlier answer',
    ts: '2026-08-27T00:00:01.000Z',
  },
]

function host(reads: Array<{ resumeValue: string; limit: number }>): TerminalRuntimeHost {
  return {
    readTranscript: async (session, range) => {
      reads.push({ resumeValue: session.resume?.value ?? '', limit: range.limit })
      return WITNESS.slice(-range.limit)
    },
  } as unknown as TerminalRuntimeHost
}

function serverRuntime(id: string, harness: string) {
  return {
    driver: {
      id,
      harness,
      family: 'server',
      capabilities: () => ({ placement: 'dedicated' as const }),
    },
    handleFor: () => undefined,
    bindings: () => [],
    journal: { read: () => undefined, clear: vi.fn() },
    launch: vi.fn(async () => {}),
    adoptFromJournal: vi.fn(async () => undefined),
    dispose: vi.fn(),
  }
}

describe('Claude SDK daemon host adapter', () => {
  it('resumes under the exact Podium id and reads the same conversation witness', async () => {
    const sent: DaemonMessage[] = []
    const reads: Array<{ resumeValue: string; limit: number }> = []
    const childSpecs: HeadlessTurnSpec[] = []
    vi.mocked(runClaudeSdkChildTurn).mockImplementation((spec) => {
      childSpecs.push(spec)
      return {
        done: Promise.resolve({
          harnessSessionId: spec.resumeValue ?? spec.sessionUuid ?? RESUME.value,
          output: 'the next answer',
        }),
        interrupt: vi.fn(),
        answerPermission: vi.fn(),
        dispose: vi.fn(),
      } satisfies HeadlessTurnHandle
    })

    const runtime = createDaemonClaudeSdkRuntime({
      send: (message) => sent.push(message),
      host: host(reads),
    })
    const handle = await runtime.launch({
      sessionId: SESSION_ID,
      cwd: '/project',
      resume: RESUME,
    })

    expect(handle.binding).toMatchObject({
      sessionId: SESSION_ID,
      driver: 'claude-sdk',
      resume: RESUME,
    })
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        sessionId: SESSION_ID,
        runtimeContract: true,
        driverId: 'claude-sdk',
      }),
    )
    expect(sent).toContainEqual({
      type: 'sessionResumeRef',
      sessionId: SESSION_ID,
      resume: RESUME,
      confidence: 'exact',
    })
    await expect(handle.transcript.history({ limit: 10 })).resolves.toEqual(WITNESS)
    expect(reads).toEqual([{ resumeValue: RESUME.value, limit: 10 }])

    const receipt = await handle.send(
      { id: 'follow-up', text: 'continue the existing conversation' },
      { origin: 'human', delivery: 'when-ready' },
    )
    expect(receipt.outcome).toBe('accepted')
    expect(childSpecs).toHaveLength(1)
    expect(childSpecs[0]).toMatchObject({
      cwd: '/project',
      prompt: 'continue the existing conversation',
      resumeValue: RESUME.value,
    })
    expect(childSpecs[0]).not.toHaveProperty('sessionUuid')
    await handle.stop()
    runtime.dispose()
  })

  it('routes process-gone resume through the machine root and publishes once', async () => {
    const sent: DaemonMessage[] = []
    const claude = createDaemonClaudeSdkRuntime({
      send: (message) => sent.push(message),
      host: host([]),
    })
    const terminal = {
      driverFor: vi.fn(),
      handleFor: () => undefined,
      bindings: () => [],
      observe: vi.fn(),
      onHookPayload: vi.fn(),
      register: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    }
    const machine = createDaemonMachineRuntime({
      terminal,
      claude,
      opencode: serverRuntime('opencode-server', 'opencode'),
      codex: serverRuntime('codex-app-server', 'codex'),
      grok: serverRuntime('grok-acp', 'grok'),
      inventory: async () => ({ os: 'linux', arch: 'x64', agents: [], tools: [] }),
    } as unknown as Parameters<typeof createDaemonMachineRuntime>[0])

    const handle = await machine.resume(
      RESUME,
      {
        harness: 'claude-code',
        selection: {
          auth: 'unknown',
          platform: 'linux',
          available: ['claude-sdk'],
          preference: 'claude-sdk',
          role: 'interactive',
        },
        workdir: '/project',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      },
      SESSION_ID,
    )

    expect(handle.binding).toMatchObject({
      sessionId: SESSION_ID,
      driver: 'claude-sdk',
      resume: RESUME,
    })
    const binds = sent.filter((message) => message.type === 'bind')
    const states = sent.filter((message) => message.type === 'agentState')
    const refs = sent.filter((message) => message.type === 'sessionResumeRef')
    expect(binds).toHaveLength(1)
    expect(binds[0]).toMatchObject({
      sessionId: SESSION_ID,
      runtimeContract: true,
      driverId: 'claude-sdk',
    })
    expect(states.length).toBeGreaterThanOrEqual(1)
    expect(refs).toEqual([
      {
        type: 'sessionResumeRef',
        sessionId: SESSION_ID,
        resume: RESUME,
        confidence: 'exact',
      },
    ])
    machine.dispose()
  })
  it('forwards queued teardown loss once through the durable daemon contract', async () => {
    const sent: DaemonMessage[] = []
    vi.mocked(runClaudeSdkChildTurn).mockImplementation(
      () =>
        ({
          done: new Promise(() => {}),
          interrupt: vi.fn(),
          answerPermission: vi.fn(),
          dispose: vi.fn(),
        }) satisfies HeadlessTurnHandle,
    )

    const runtime = createDaemonClaudeSdkRuntime({
      send: (message) => sent.push(message),
      host: host([]),
    })
    const handle = await runtime.launch({ sessionId: SESSION_ID, cwd: '/project', resume: RESUME })
    await handle.send({ id: 'active', text: 'active' }, { origin: 'human', delivery: 'when-ready' })
    await handle.send(
      { id: 'queued-one', text: 'queued one' },
      { origin: 'human', delivery: 'queue' },
    )
    await handle.send(
      { id: 'queued-two', text: 'queued two' },
      { origin: 'human', delivery: 'queue' },
    )

    await expect(handle.hibernate()).resolves.toEqual({ ok: true })
    await handle.stop()
    runtime.dispose()

    expect(sent.filter((message) => message.type === 'runtimeQueueDrainAbandoned')).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        turnIds: ['queued-one', 'queued-two'],
        reason: 'teardown',
        reportId: expect.any(String),
      }),
    ])
  })
})
