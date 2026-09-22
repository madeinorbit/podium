/**
 * THE CLAUDE SDK SESSION ADAPTER (POD-4499): launch/resume/transcript/turn
 * translation at the session layer, over the stream engine host.
 *
 * The engine (one long-lived `claude` child per session under podium-host)
 * arrives as an injected port; this file pins that the adapter starts turns
 * through it, publishes the bind once, reads the same conversation witness,
 * and adopts from the journal after a restart.
 */
import { pageHistory } from '../../history.js'
import type { ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeSdkTurnHandle } from './runtime.js'
import type { ClaudeEngineHost } from './engine-host.js'
import { createClaudeSdkSessionRuntime, type ClaudeSdkSessionDeps } from './session.js'
import { createMemoryDriverSlots } from '../../testing/index.js'

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

type StartTurnInput = Parameters<ClaudeEngineHost['startTurn']>[0]

function fakeEngine(
  impl: (input: StartTurnInput) => ClaudeSdkTurnHandle = () => ({
    done: Promise.resolve({
      resumeValue: RESUME.value,
      output: 'the next answer',
      observedModel: 'claude-opus-5',
      observedEffort: 'max',
    }),
    interrupt: vi.fn(),
    requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
    answerPermission: vi.fn(),
    dispose: vi.fn(),
  }),
): ClaudeEngineHost & { startTurn: ReturnType<typeof vi.fn> } {
  return {
    journal: { read: () => undefined, write: vi.fn(), clear: vi.fn() },
    startTurn: vi.fn(impl),
    stopEngine: vi.fn(async () => {}),
    releaseEngines: vi.fn(),
  }
}

function sessionWorld(
  sent: DaemonMessage[],
  reads: Array<{ resumeValue: string; limit: number }>,
  engine: ClaudeEngineHost,
  extra: Partial<ClaudeSdkSessionDeps> = {},
) {
  return createClaudeSdkSessionRuntime({
    driverSlots: createMemoryDriverSlots(),
    send: (message) => sent.push(message),
    emitBind: (bind) => {
      sent.push({ type: 'bind', ...bind })
    },
    sessionReady: () => {},
    traceRuntimeEvent: () => {},
    startMailContinuation: () => () => {},
    facts: {
      harnessKind: 'claude-code',
      command: 'claude',
      stripEnv: [],
      scopeToken: 'cl',
      journalNamespace: 'claude-engines',
      attachKind: 'claude-code',
    },
    engine,
    transcript: transcript(reads),
    ...extra,
  })
}

describe('Claude SDK daemon host adapter', () => {
  it('resumes under the exact Podium id and reads the same conversation witness', async () => {
    const sent: DaemonMessage[] = []
    const reads: Array<{ resumeValue: string; limit: number }> = []
    const turnInputs: StartTurnInput[] = []
    const engine = fakeEngine((input) => {
      turnInputs.push(input)
      return {
        done: Promise.resolve({
          resumeValue: input.resumeValue,
          output: 'the next answer',
          observedModel: 'claude-opus-5',
          observedEffort: 'max',
        }),
        interrupt: vi.fn(),
        requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
        answerPermission: vi.fn(),
        dispose: vi.fn(),
      }
    })

    const runtime = sessionWorld(sent, reads, engine)
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
    expect(turnInputs).toHaveLength(1)
    // The resumed conversation continues on its harness session id — never a
    // minted one — and the turn carries the session's model policy.
    expect(turnInputs[0]?.resumeValue).toBe(RESUME.value)
    expect(turnInputs[0]?.newConversation).toBe(false)
    expect(turnInputs[0]?.spec.workdir).toBe('/project')
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
    const engine = fakeEngine(
      () =>
        ({
          done: new Promise(() => {}),
          interrupt: vi.fn(),
          requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
          answerPermission: vi.fn(),
          dispose: vi.fn(),
        }) satisfies ClaudeSdkTurnHandle,
    )

    const runtime = sessionWorld(sent, [], engine)
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
    const engine = fakeEngine(
      () =>
        ({
          done: Promise.reject(new Error('not logged in — run /login')),
          interrupt: vi.fn(),
          requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
          answerPermission: vi.fn(),
          dispose: vi.fn(),
        }) satisfies ClaudeSdkTurnHandle,
    )

    const runtime = sessionWorld(sent, [], engine)
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

  it('publishes engine death as its own class, not auth or quota', async () => {
    const sent: DaemonMessage[] = []
    const engine = fakeEngine(
      () =>
        ({
          done: Promise.reject(
            new Error('the Claude model host process exited with code 1 before the turn finished'),
          ),
          interrupt: vi.fn(),
          requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
          answerPermission: vi.fn(),
          dispose: vi.fn(),
        }) satisfies ClaudeSdkTurnHandle,
    )

    const runtime = sessionWorld(sent, [], engine)
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
   * POD-3057, KEPT AT THE SESSION LAYER AS ENV PLUMBING. The reader resolves
   * the session's JSONL under the daemon's agent home; the engine child must
   * run under the same HOME. The overlay itself is the engine host's job
   * (pinned in engine-host.test.ts); what stays here is that the spawn
   * frame's env reaches the engine untouched — including against a spawn
   * frame that names the machine home.
   */
  it('hands the spawn frame env to the engine over the session spec', async () => {
    const turnInputs: StartTurnInput[] = []
    const engine = fakeEngine((input) => {
      turnInputs.push(input)
      return {
        done: Promise.resolve({ resumeValue: 'sdk-thread', output: 'answered' }),
        interrupt: vi.fn(),
        requestInterrupt: vi.fn(async () => ({ outcome: 'accepted' as const })),
        answerPermission: vi.fn(),
        dispose: vi.fn(),
      }
    })

    const runtime = sessionWorld([], [], engine)
    const handle = await runtime.launch({
      sessionId: SESSION_ID,
      cwd: '/project',
      env: { HOME: '/home/operator', PODIUM_SESSION_ID: SESSION_ID },
    })
    await handle.send({ id: 'first', text: 'hello' }, { origin: 'human', delivery: 'when-ready' })

    expect(turnInputs).toHaveLength(1)
    expect(turnInputs[0]?.spec.env).toMatchObject({
      HOME: '/home/operator',
      PODIUM_SESSION_ID: SESSION_ID,
    })
    await handle.stop()
    runtime.dispose()
  })

  it('ends the engine when the session stops, and detaches it on dispose', async () => {
    const engine = fakeEngine()
    const runtime = sessionWorld([], [], engine)
    const handle = await runtime.launch({ sessionId: SESSION_ID, cwd: '/project' })
    await handle.stop()
    expect(engine.stopEngine).toHaveBeenCalledWith(SESSION_ID, true)
    runtime.dispose()
    expect(engine.releaseEngines).toHaveBeenCalled()
  })

  it('hibernates the engine without retiring the journal', async () => {
    const engine = fakeEngine()
    const runtime = sessionWorld([], [], engine)
    const handle = await runtime.launch({ sessionId: SESSION_ID, cwd: '/project', resume: RESUME })
    await expect(handle.hibernate()).resolves.toEqual({ ok: true })
    expect(engine.stopEngine).toHaveBeenCalledWith(SESSION_ID, false)
    runtime.dispose()
  })

  describe('adoptFromJournal', () => {
    it('resumes the journalled conversation under the exact Podium id', async () => {
      const sent: DaemonMessage[] = []
      const engine = fakeEngine()
      const journal = {
        read: () => ({
          sessionId: SESSION_ID,
          claudeSessionId: 'claude-native-9',
          workdir: '/project',
          process: { key: 'podium-cl-claude-adapter-session' },
          model: 'claude-opus-5',
          bindingVersion: 1,
        }),
        write: vi.fn(),
        clear: vi.fn(),
      }
      const runtime = sessionWorld(sent, [], { ...engine, journal })
      const handle = await runtime.adoptFromJournal(SESSION_ID)
      expect(handle?.binding).toMatchObject({
        sessionId: SESSION_ID,
        driver: 'claude-sdk',
        resume: { kind: 'claude-session', value: 'claude-native-9' },
      })
      // No fresh bind: the session was bound at launch, and adopt only
      // re-arms the contract core (pump) and re-reports the resume ref —
      // the same shape the codex/grok adopts keep.
      expect(sent.filter((message) => message.type === 'bind')).toEqual([])
      expect(sent).toContainEqual({
        type: 'sessionResumeRef',
        sessionId: SESSION_ID,
        resume: { kind: 'claude-session', value: 'claude-native-9' },
        confidence: 'exact',
      })
      runtime.dispose()
    })

    it('answers undefined when no journal names the session', async () => {
      const runtime = sessionWorld([], [], fakeEngine())
      await expect(runtime.adoptFromJournal(SESSION_ID)).resolves.toBeUndefined()
      runtime.dispose()
    })

    it('refuses a journal entry for another process key', async () => {
      const engine = fakeEngine()
      const journal = {
        read: () => ({
          sessionId: SESSION_ID,
          claudeSessionId: 'claude-native-9',
          workdir: '/project',
          process: { key: 'podium-cx-something-else' },
          bindingVersion: 1,
        }),
        write: vi.fn(),
        clear: vi.fn(),
      }
      const runtime = sessionWorld([], [], { ...engine, journal })
      await expect(runtime.adoptFromJournal(SESSION_ID)).resolves.toBeUndefined()
      runtime.dispose()
    })

    it('exposes the journal projection and clears it on demand', async () => {
      const engine = fakeEngine()
      const stored = {
        sessionId: SESSION_ID,
        claudeSessionId: 'claude-native-9',
        workdir: '/work',
        process: { key: 'podium-cl-claude-adapter-session', pid: 4242 },
        bindingVersion: 1,
      }
      const journal = {
        read: (sessionId: SessionId) => (sessionId === SESSION_ID ? stored : undefined),
        write: vi.fn(),
        clear: vi.fn(),
      }
      const runtime = sessionWorld([], [], { ...engine, journal })
      expect(runtime.journalEntry(SESSION_ID)).toEqual({
        workdir: '/work',
        process: { key: 'podium-cl-claude-adapter-session', pid: 4242 },
        bindingVersion: 1,
      })
      expect(runtime.journalEntry('no-such-session' as SessionId)).toBeUndefined()
      runtime.clearJournal(SESSION_ID)
      expect(journal.clear).toHaveBeenCalledWith(SESSION_ID)
      runtime.dispose()
    })
  })
})
