/**
 * THE CLAUDE SDK SESSION ADAPTER (moved from
 * apps/daemon/src/runtime/claude-sdk-driver.test.ts in 1.5 with the code it
 * pins: launch/resume/transcript/turn/env translation at the session layer.
 */
import { pageHistory } from '../../history.js'
import type { ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeSdkChildHandle, ClaudeSdkChildTurnInput } from './child-turn.js'
import { runClaudeSdkChildTurn } from './child-turn.js'
import { createClaudeSdkSessionRuntime, type ClaudeSdkSessionDeps } from './session.js'

vi.mock('./child-turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./child-turn.js')>()),
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

function transcript(reads: Array<{ resumeValue: string; limit: number }>) {
  return {
    readHistory: async (
      session: { resume?: { value?: string } },
      range: { limit: number },
    ) => {
      reads.push({ resumeValue: session.resume?.value ?? '', limit: range.limit })
      return pageHistory(WITNESS, session.resume?.value ?? '', range)
    },
    archiveTranscript: async () => ({ path: '/tmp/archive.jsonl' }),
    readFileBytes: async () => new Uint8Array(),
  }
}

function sessionWorld(
  sent: DaemonMessage[],
  reads: Array<{ resumeValue: string; limit: number }>,
  extra: Partial<ClaudeSdkSessionDeps> = {},
) {
  return createClaudeSdkSessionRuntime({
    send: (message) => sent.push(message),
    emitBind: (bind) => {
      sent.push({ type: 'bind', ...bind })
    },
    sessionReady: () => {},
    traceRuntimeEvent: () => {},
    startMailContinuation: () => () => {},
    transcript: transcript(reads),
    composeChildEnv: (_agent, explicit) => ({ ...explicit }),
    ...extra,
  })
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
    const childSpecs: ClaudeSdkChildTurnInput[] = []
    vi.mocked(runClaudeSdkChildTurn).mockImplementation((spec) => {
      childSpecs.push(spec)
      return {
        done: Promise.resolve({
          harnessSessionId: spec.resumeValue ?? spec.sessionUuid ?? RESUME.value,
          output: 'the next answer',
          observedModel: 'claude-opus-5',
          observedEffort: 'max',
        }),
        interrupt: vi.fn(),
        requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
        answerPermission: vi.fn(),
        dispose: vi.fn(),
      } satisfies ClaudeSdkChildHandle
    })

    const runtime = sessionWorld(sent, reads, { executablePath: '/opt/claude/2.1.236/claude' })
    const handle = await runtime.launch({
      sessionId: SESSION_ID,
      cwd: '/project',
      resume: RESUME,
      model: 'claude-opus-5',
      effort: 'max',
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
        driverId: 'claude-sdk',
      }),
    )
    expect(sent).toContainEqual({
      type: 'sessionResumeRef',
      sessionId: SESSION_ID,
      resume: RESUME,
      confidence: 'exact',
    })
    await expect(handle.transcript.history({ limit: 10 }).then((page) => page.items)).resolves.toEqual(WITNESS)
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
      model: 'claude-opus-5',
      effort: 'max',
      executablePath: '/opt/claude/2.1.236/claude',
    })
    expect(childSpecs[0]).not.toHaveProperty('sessionUuid')
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        type: 'agentModel',
        sessionId: SESSION_ID,
        model: 'claude-opus-5',
        effort: 'max',
      }),
    )
    await handle.stop()
    runtime.dispose()
  })

  it('forwards queued teardown loss once through the durable daemon contract', async () => {
    const sent: DaemonMessage[] = []
    vi.mocked(runClaudeSdkChildTurn).mockImplementation(
      () =>
        ({
          done: new Promise(() => {}),
          interrupt: vi.fn(),
          requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
          answerPermission: vi.fn(),
          dispose: vi.fn(),
        }) satisfies ClaudeSdkChildHandle,
    )

    const runtime = sessionWorld(sent, [])
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

  it('publishes classified turn failures onto agentState and the transcript before closing the epoch', async () => {
    const sent: DaemonMessage[] = []
    vi.mocked(runClaudeSdkChildTurn).mockImplementation(
      () =>
        ({
          done: Promise.reject(new Error('not logged in — run /login')),
          interrupt: vi.fn(),
          requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
          answerPermission: vi.fn(),
          dispose: vi.fn(),
        }) satisfies ClaudeSdkChildHandle,
    )

    const runtime = sessionWorld(sent, [])
    const handle = await runtime.launch({ sessionId: SESSION_ID, cwd: '/project' })
    await handle.send({ id: 'prompt', text: 'hello' }, { origin: 'human', delivery: 'when-ready' })

    await vi.waitFor(() => {
      expect(
        sent.some(
          (message) =>
            message.type === 'agentState' &&
            message.state.phase === 'errored' &&
            message.state.error?.class === 'authentication',
        ),
      ).toBe(true)
    })

    const items = sent
      .filter(
        (message): message is Extract<DaemonMessage, { type: 'transcriptDelta' }> =>
          message.type === 'transcriptDelta',
      )
      .flatMap((message) => message.items)
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: 'hello' }),
        expect.objectContaining({
          role: 'system',
          text: expect.stringMatching(/Provider authentication failed/i),
        }),
      ]),
    )

    const order: string[] = []
    for (const message of sent) {
      if (message.type !== 'runtimeEvent') continue
      const event = message.event
      if (event.t === 'turn' && event.ev.ev === 'failed') order.push('turn:failed')
      else if (event.t === 'state' && event.change.kind === 'turn_failed') {
        order.push('state:turn_failed')
      } else if (event.t === 'item' && event.item.kind === 'complete') {
        order.push(`item:${event.item.item.role}`)
      }
    }
    expect(order).toEqual(['item:user', 'state:turn_failed', 'item:system', 'turn:failed'])

    await handle.stop()
    runtime.dispose()
  })

  it('publishes host death as its own class, not auth or quota', async () => {
    const sent: DaemonMessage[] = []
    vi.mocked(runClaudeSdkChildTurn).mockImplementation(
      () =>
        ({
          done: Promise.reject(
            new Error('the Claude model host process exited with code 1 before the turn finished'),
          ),
          interrupt: vi.fn(),
          requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
          answerPermission: vi.fn(),
          dispose: vi.fn(),
        }) satisfies ClaudeSdkChildHandle,
    )

    const runtime = sessionWorld(sent, [])
    const handle = await runtime.launch({ sessionId: SESSION_ID, cwd: '/project' })
    await handle.send({ id: 'prompt', text: 'hello' }, { origin: 'human', delivery: 'when-ready' })

    await vi.waitFor(() => {
      expect(
        sent.some(
          (message) =>
            message.type === 'agentState' &&
            message.state.phase === 'errored' &&
            message.state.error?.class === 'host_death',
        ),
      ).toBe(true)
    })
    expect(
      sent.some(
        (message) =>
          message.type === 'transcriptDelta' &&
          message.items.some(
            (item) => item.role === 'system' && /Model host process died/i.test(item.text),
          ),
      ),
    ).toBe(true)

    await handle.stop()
    runtime.dispose()
  })
  /**
   * POD-3057. `readTranscript` above resolves the session's JSONL under the
   * daemon's agent home; the child writes it under its own `HOME`. When those
   * two are different homes the reader addresses a file nobody wrote and
   * `sessions.read` answers `items: []` for a conversation that really happened.
   * So the home is asserted where the child receives it — on the turn spec that
   * becomes its environment — including against a spawn frame that names one.
   */
  it('runs the SDK child under the instance agent home, over the spawn frame env', async () => {
    const childSpecs: ClaudeSdkChildTurnInput[] = []
    vi.mocked(runClaudeSdkChildTurn).mockImplementation((spec) => {
      childSpecs.push(spec)
      return {
        done: Promise.resolve({ harnessSessionId: 'sdk-thread', output: 'answered' }),
        interrupt: vi.fn(),
        requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
        answerPermission: vi.fn(),
        dispose: vi.fn(),
      } satisfies ClaudeSdkChildHandle
    })

    const runtime = sessionWorld([], [], {
      send: () => {},
      homeDir: '/state/p3057/agent-home',
    })
    const handle = await runtime.launch({
      sessionId: SESSION_ID,
      cwd: '/project',
      // The machine home, arriving the way it really arrives: as the spawn
      // frame's server-resolved env. The instance's own home outranks it.
      env: { HOME: '/home/operator', PODIUM_SESSION_ID: SESSION_ID },
    })
    await handle.send({ id: 'first', text: 'hello' }, { origin: 'human', delivery: 'when-ready' })

    expect(childSpecs).toHaveLength(1)
    expect(childSpecs[0]?.env).toMatchObject({
      HOME: '/state/p3057/agent-home',
      CLAUDE_CONFIG_DIR: '/state/p3057/agent-home/.claude',
      PODIUM_SESSION_ID: SESSION_ID,
    })
    await handle.stop()
    runtime.dispose()
  })

  /** The default instance has no agent home of its own: reader and child both
   *  use the ambient one, and the daemon must not invent a different answer. */
  it('leaves the child on the daemon home when the instance has none', async () => {
    const childSpecs: ClaudeSdkChildTurnInput[] = []
    vi.mocked(runClaudeSdkChildTurn).mockImplementation((spec) => {
      childSpecs.push(spec)
      return {
        done: Promise.resolve({ harnessSessionId: 'sdk-thread', output: 'answered' }),
        interrupt: vi.fn(),
        requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
        answerPermission: vi.fn(),
        dispose: vi.fn(),
      } satisfies ClaudeSdkChildHandle
    })

    const runtime = sessionWorld([], [], { send: () => {} })
    const handle = await runtime.launch({ sessionId: SESSION_ID, cwd: '/project' })
    await handle.send({ id: 'first', text: 'hello' }, { origin: 'human', delivery: 'when-ready' })

    expect(childSpecs).toHaveLength(1)
    expect(childSpecs[0]?.env?.HOME).toBeUndefined()
    expect(childSpecs[0]?.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    await handle.stop()
    runtime.dispose()
  })
})
