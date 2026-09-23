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
import { createClaudeEngineHost, type ClaudeEngineHost } from './engine-host.js'
import type { EngineAttachment } from '../engine-supervision.js'
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
    bindings: { recorded: () => undefined, bound: vi.fn(), released: vi.fn() },
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
        recorded: () => ({
          sessionId: SESSION_ID,
          claudeSessionId: 'claude-native-9',
          workdir: '/project',
          process: { key: 'podium-cl-claude-adapter-session' },
          model: 'claude-opus-5',
          bindingVersion: 1,
        }),
        bound: vi.fn(),
        released: vi.fn(),
      }
      const runtime = sessionWorld(sent, [], { ...engine, bindings: journal })
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

    it('re-adopts a session this daemon still holds instead of resuming a second core', async () => {
      // A server reconnect re-sends reattach for live sessions, including one
      // that has not run a turn — so nothing is journalled yet (POD-4612).
      const sent: DaemonMessage[] = []
      const engine = {
        ...fakeEngine(),
        processFor: (sessionId: SessionId) => ({
          key: `podium-cl-${sessionId}`,
          scopeUnit: `podium-scope-${sessionId}.scope`,
        }),
      }
      const runtime = sessionWorld(sent, [], engine)
      const launched = await runtime.launch({ sessionId: SESSION_ID, cwd: '/project' })
      // The handle's binding carries the ENGINE's identity — what the generic
      // server reap measures — not an in-memory placeholder.
      expect(launched.binding.process).toEqual({
        key: 'podium-cl-claude-adapter-session',
        scopeUnit: 'podium-scope-claude-adapter-session.scope',
      })
      expect(launched.binding.family).toBe('server')
      // Held but unjournalled: the family still answers "mine" to the generic arm.
      expect(runtime.journalEntry(SESSION_ID)).toEqual({
        workdir: '/project',
        process: launched.binding.process,
        bindingVersion: 1,
        resume: launched.binding.resume,
      })

      const adopted = await runtime.adoptFromJournal(SESSION_ID)
      expect(adopted?.binding).toMatchObject({
        sessionId: SESSION_ID,
        resume: launched.binding.resume,
        bindingVersion: 2,
      })
      expect(runtime.handleFor(SESSION_ID)).toBe(adopted)
      expect(runtime.bindings()).toHaveLength(1)
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
        recorded: () => ({
          sessionId: SESSION_ID,
          claudeSessionId: 'claude-native-9',
          workdir: '/project',
          process: { key: 'podium-cx-something-else' },
          bindingVersion: 1,
        }),
        bound: vi.fn(),
        released: vi.fn(),
      }
      const runtime = sessionWorld([], [], { ...engine, bindings: journal })
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
        recorded: (sessionId: SessionId) => (sessionId === SESSION_ID ? stored : undefined),
        bound: vi.fn(),
        released: vi.fn(),
      }
      const runtime = sessionWorld([], [], { ...engine, bindings: journal })
      expect(runtime.journalEntry(SESSION_ID)).toEqual({
        workdir: '/work',
        process: { key: 'podium-cl-claude-adapter-session', pid: 4242 },
        bindingVersion: 1,
        // The conversation, so the generic reattach arm can refuse a row that
        // names a different one (POD-4612).
        resume: { kind: 'claude-session', value: 'claude-native-9' },
      })
      expect(runtime.journalEntry('no-such-session' as SessionId)).toBeUndefined()
      runtime.clearJournal(SESSION_ID)
      expect(journal.released).toHaveBeenCalledWith(SESSION_ID)
      runtime.dispose()
    })
  })

  /**
   * THE INITIAL PROMPT, END TO END THROUGH THE REAL ENGINE HOST (POD-4636).
   *
   * The CLI fake answers the way claude-code 2.1.280 really does in
   * streaming-input mode: `initialize` gets its control_response and nothing
   * else — `system/init` is written only once a user line arrives. A client
   * that holds the first user line until it has seen `system/init` waits on a
   * message the user line itself is what triggers.
   */
  it('delivers the initial prompt as a stream-json user line and opens a live turn', async () => {
    const sent: DaemonMessage[] = []
    const writes: string[] = []
    const dataCbs = new Set<(seq: bigint, data: Buffer) => void>()
    let claudeSessionId = ''
    const stdout = (value: unknown): void => {
      for (const cb of [...dataCbs]) cb(0n, Buffer.from(`${JSON.stringify(value)}\n`))
    }
    const attachment = {
      ready: Promise.resolve({ lease: true, childPid: 4242 }),
      connection: {
        onData: (cb: (seq: bigint, data: Buffer) => void) => {
          dataCbs.add(cb)
          return () => dataCbs.delete(cb)
        },
        onExit: () => () => {},
        signal: () => {},
        write: async (data: Uint8Array) => {
          for (const line of Buffer.from(data).toString('utf8').split('\n')) {
            if (!line.trim()) continue
            writes.push(line)
            const msg = JSON.parse(line)
            if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
              queueMicrotask(() =>
                stdout({
                  type: 'control_response',
                  response: { subtype: 'success', request_id: msg.request_id, response: {} },
                }),
              )
            } else if (msg.type === 'user') {
              queueMicrotask(() => {
                stdout({ type: 'system', subtype: 'init', session_id: claudeSessionId })
                stdout({ type: 'result', subtype: 'success', result: 'fifty-six MANGO' })
              })
            }
          }
          return data.byteLength
        },
      },
      dispose: () => {},
    } as unknown as EngineAttachment
    const bound = vi.fn()
    const engine = createClaudeEngineHost({
      facts: {
        harnessKind: 'claude-code',
        command: 'claude',
        stripEnv: [],
        scopeToken: 'cl',
        journalNamespace: 'claude-engines',
        attachKind: 'claude-code',
      },
      supervision: { scopeUnitFor: () => undefined },
      engines: {
        startEngine: async (req) => {
          const at = req.args.indexOf('--session-id')
          claudeSessionId = at >= 0 ? (req.args[at + 1] ?? '') : ''
          return { attachment }
        },
        reattachEngine: async () => {
          throw new Error('unexpected reattach')
        },
        engineAlive: async () => false,
        destroyEngine: async () => {},
        bound,
        released: vi.fn(),
        recorded: () => undefined,
      },
      buildEnv: ({ sessionEnv }) => ({ ...(sessionEnv ?? {}) }),
      gracefulExitMs: 50,
      executablePath: '/bin/claude',
    })

    const runtime = sessionWorld(sent, [], engine)
    await runtime.launch({
      sessionId: SESSION_ID,
      cwd: '/project',
      initialPrompt: 'What is 7 times 8? Answer with MANGO.',
    })

    // The prompt reaches the engine's stdin as a stream-json user line.
    await vi.waitFor(
      () => {
        const user = writes.map((line) => JSON.parse(line)).find((msg) => msg.type === 'user')
        expect(user?.message?.content).toEqual([
          { type: 'text', text: 'What is 7 times 8? Answer with MANGO.' },
        ])
      },
      { timeout: 2000 },
    )
    // The turn it opened is reported LIVE. A turn start relabelled as
    // bootstrap lies behind the checkpoint `session_started` already set, so
    // the server's event gate refuses it and every later event of that turn.
    const turnStarted = sent
      .flatMap((message) => (message.type === 'runtimeEvent' ? [message.event] : []))
      .find((event) => event.t === 'turn' && event.ev.ev === 'started')
    expect(turnStarted).toMatchObject({ provenance: 'live', turnEpoch: 1 })
    // And the answer comes back.
    await vi.waitFor(
      () =>
        expect(sent).toContainEqual(
          expect.objectContaining({
            type: 'transcriptDelta',
            sessionId: SESSION_ID,
            items: [expect.objectContaining({ role: 'assistant', text: 'fifty-six MANGO' })],
          }),
        ),
      { timeout: 2000 },
    )
    // The journal names the conversation the invocation minted.
    expect(bound).toHaveBeenCalledWith(expect.objectContaining({ claudeSessionId }))
    runtime.dispose()
  })
})
