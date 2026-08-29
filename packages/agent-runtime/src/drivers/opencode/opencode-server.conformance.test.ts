/**
 * THE opencode SERVER DRIVER UNDER THE CONFORMANCE CORPUS — ZERO EXEMPTIONS
 * BEYOND THE ONE ITS FAMILY CARRIES (POD-1761 W5; plan §5).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS FAKE
 * ---------------------------------------------------------------------------
 *
 * REAL: every line of the driver, the client, the SSE parser, the event mapping,
 * the receipt logic, the interaction reconciliation — and the TRANSPORT. The
 * server on the other end is a real `node:http` listener on a real loopback
 * port, speaking the shapes recorded from opencode 1.18.16, enforcing the same
 * Basic-auth check. The unauthenticated-connection refusal is proved by opening
 * an actual connection with no credentials.
 *
 * FAKE: the agent. No model runs, no PTY exists, nothing waits out a timing
 * ladder. That is what makes this the epic's first driver whose conformance run
 * is deterministic end to end — the terminal driver had to virtualize a clock to
 * get here, and this one simply has no clock to virtualize.
 *
 * ---------------------------------------------------------------------------
 * THE EXEMPTION LIST IS THE HEADLINE
 * ---------------------------------------------------------------------------
 *
 * `SERVER_PERMITTED_FAILURES` is `['no-native-steer']` and nothing else. The two
 * that matter — `unverified-send` and `at-least-once-interactions` — are the
 * terminal family's, this driver claims neither, and the corpus refuses a driver
 * that claims a weakness its family does not permit AND one that exhibits a
 * weakness it did not claim. `no-native-steer` is on the row because opencode
 * has no steer verb; the argument, and the measurement behind it, are in
 * `../../permitted-failures.ts`.
 */

import type { SessionId, TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../../events.js'
// `assertAttachHonoursOneControlLease` is the assertion, not a copy of it: the
// refusal arm below is judged by the same corpus function the run judges its
// endpoint arm with. Imported from the module rather than the `testing/` barrel
// because the barrel is the corpus's surface to curate, and this file has no
// business widening it.
import { assertAttachHonoursOneControlLease } from '../../testing/conformance/suite.js'
import type { ConformanceControl, ConformanceTarget } from '../../testing/index.js'
import { runConformance } from '../../testing/index.js'
import { createOpencodeClient, type OpencodeClient } from './client.js'
import { SERVER_PERMITTED_FAILURES } from './permitted-failures.js'
import {
  createOpencodeRuntime,
  type OpencodeJournal,
  type OpencodeJournalEntry,
  type OpencodeRuntime,
  type OpencodeRuntimeHost,
  type OpencodeServerEndpoint,
} from './runtime.js'
import {
  type FakeOpencodeServer,
  type FakeOpencodeSession,
  startFakeOpencodeServer,
} from './test-support/fake-server.js'

/**
 * A server per session, started on demand and remembered.
 *
 * SYNCHRONOUS CONTROL OVER AN ASYNCHRONOUS WORLD is the only awkward part of
 * this fixture, and it is the corpus's shape rather than a defect: `askInteraction`
 * returns a `string`, not a promise. The fake's ask is therefore recorded in the
 * server's pending list SYNCHRONOUSLY (so a `GET /permission` immediately after
 * sees it) and ALSO announced on the SSE stream (so a live consumer sees it the
 * way opencode delivers it). The driver reconciles against the list before every
 * `send`/`interactions`/unknown `answer`, which is exactly why it does not
 * depend on the stream having arrived — and that reconciliation is not a test
 * affordance: it is what makes an ask raised while a socket was down, or
 * answered at an attached TUI, visible at all.
 */
interface WorldOptions {
  /**
   * WHICH ATTACH MODES THIS MACHINE CAN RUN `opencode attach <url>` FOR. A host
   * fact, not a driver fact — the capability declares `client` in every one of
   * them, and what changes is whether this box can start one.
   *
   *   `true` (default)     both, the ordinary machine;
   *   `false`              neither — nowhere to run a terminal at all;
   *   `'spectators-only'`  a stream for watchers, but no CONTROL terminal.
   *
   * The driver turns each `undefined` into the corpus's typed refusal; see
   * `attachClient`. The third is not a hypothetical shape invented for a test:
   * it is a box that can pipe a read-only stream out but has no seat to put a
   * controlling human in, and it is the ONLY host on which the corpus reaches
   * its refused-TAKEOVER assertion — see the second `describe` below.
   */
  hostsClientTerminals?: boolean | 'spectators-only'
  stageAttachment?: OpencodeRuntimeHost['stageAttachment']
}

function makeWorld(options: WorldOptions = {}): {
  target: ConformanceTarget
  prompt(sessionId: SessionId): ReturnType<FakeOpencodeServer['lastPrompt']>
  failTurn(sessionId: SessionId): void
  observed: Array<{ sessionId: SessionId; model: string; effort?: string }>
  /** The same channel with the error the caller names — `MessageAborted` is the
   *  one opencode sends for a cancelled turn (POD-2792). */
  emitSessionError(sessionId: SessionId, error: { name: string; message: string }): void
} {
  const hostsClientTerminals = options.hostsClientTerminals ?? true
  let runtime: OpencodeRuntime | undefined
  let seq = 0
  const servers = new Map<SessionId, FakeOpencodeServer>()
  const opencodeIds = new Map<SessionId, string>()
  const secretRefused = new Map<SessionId, boolean>()
  const started: FakeOpencodeServer[] = []
  /** ONE conversation store for every server this world starts — opencode's
   *  shared sqlite, which outlives any single `opencode serve`. See
   *  `startFakeOpencodeServer`'s `store` for why a private map per server
   *  modelled the wrong world. */
  const store = new Map<string, FakeOpencodeSession>()
  const entries = new Map<SessionId, OpencodeJournalEntry>()
  const observed: Array<{ sessionId: SessionId; model: string; effort?: string }> = []

  const journal: OpencodeJournal = {
    read: (sessionId) => entries.get(sessionId),
    write: (entry) => {
      entries.set(entry.sessionId, entry)
      opencodeIds.set(entry.sessionId, entry.opencodeSessionId)
    },
    clear: (sessionId) => {
      entries.delete(sessionId)
    },
  }

  const endpointFor = (
    sessionId: SessionId,
    server: FakeOpencodeServer,
  ): OpencodeServerEndpoint => ({
    baseUrl: server.baseUrl,
    username: server.username,
    password: server.password,
    // EXACT identity. The corpus's `adopt` properties turn on this being stable
    // across a supervisor restart and unusable after a kill.
    process: {
      key: `fake-opencode-${sessionId}`,
      pid: server.pid,
      scopeUnit: `podium-${sessionId}.scope`,
    },
    stop: async () => {
      server.alive = false
      await server.close()
    },
    kill: async () => {
      server.alive = false
      await server.close()
      servers.delete(sessionId)
    },
    resources: () => ({ memoryBytes: 128 * 1024 * 1024, oomKills: 0 }),
  })

  const host: OpencodeRuntimeHost = {
    reportObservedConfiguration: (input) => observed.push(input),
    stageAttachment:
      options.stageAttachment ??
      (async ({ source }) => {
        const id = 'attachment-' + ++seq
        return {
          id,
          path: '/tmp/' + id + '-' + source.filename,
          filename: source.filename,
          mediaType: source.mediaType,
          kind: source.mediaType.startsWith('image/') ? 'image' : 'file',
        }
      }),
    async launch(input) {
      const server = await startFakeOpencodeServer({
        username: input.username,
        password: input.secret,
        store,
      })
      started.push(server)
      servers.set(input.sessionId, server)
      // THE REFUSAL, MEASURED AT LAUNCH. A real connection with no credentials,
      // against this session's real listener; the answer is cached because the
      // corpus's control surface for it is synchronous. Nothing about it is
      // simulated.
      secretRefused.set(input.sessionId, await server.probeWithoutSecret())
      return endpointFor(input.sessionId, server)
    },

    async adopt(binding) {
      const server = servers.get(binding.sessionId)
      // A killed server is gone from the map, so `adopt` correctly refuses —
      // which is the property "refuses to adopt a binding whose process did not
      // survive" reaching the code that decides it.
      if (!server || !server.alive) return undefined
      return endpointFor(binding.sessionId, server)
    },

    async attachClient(input) {
      /**
       * `opencode attach <url>` would run here on a real host — and on a host
       * with nowhere to run one, NOTHING would (POD-2059's shape).
       *
       * This used to return an endpoint unconditionally, and the comment that
       * stood here said why honestly: the fixture only had to prove the driver
       * produced the endpoint VARIANT its capability declares, because that was
       * the only thing the corpus asked. It is what made the corpus's refusal
       * arm dormant — every landed fixture hosted a client, so no target ever
       * reached it.
       *
       * `undefined` is the host contract's "this machine hosts no terminal", and
       * it is a per-MACHINE fact rather than a per-driver one: the capability
       * still declares `client`, because the variant this family produces does
       * not change with the host. What changes is whether this box can run one,
       * and the driver turns that into the typed refusal the corpus branches on.
       *
       * AND THE ANSWER MAY DEPEND ON THE MODE, which is what makes the corpus's
       * second refusal assertion reachable at all. `input.mode` has always been
       * on the host contract — a real host needs it to decide what to spawn —
       * and a machine that can hand a watcher a read-only stream while refusing
       * to seat a controller is the one shape under which a TAKEOVER gets
       * refused after a peek has already succeeded.
       */
      if (hostsClientTerminals === false) return undefined
      if (hostsClientTerminals === 'spectators-only' && input.mode === 'takeover') return undefined
      return { streamId: `oc-attach-${input.sessionId}`, warmTtlMs: 300_000 }
    },

    journal,
    now: () => Date.UTC(2026, 7, 14) + seq * 1000,
    randomSecret: () => `fake-secret-${++seq}`,
    mintSessionId: () => `oc-session-${++seq}` as SessionId,
    makeClient: (config) => createOpencodeClient(config) satisfies OpencodeClient,
  }

  const serverFor = (sessionId: SessionId): FakeOpencodeServer => {
    const server = servers.get(sessionId)
    if (!server) throw new Error(`no fake opencode server for ${sessionId}`)
    return server
  }
  const opencodeIdFor = (sessionId: SessionId): string => {
    const id = opencodeIds.get(sessionId)
    if (!id) throw new Error(`no opencode session id recorded for ${sessionId}`)
    return id
  }

  /** Distinct message/part ids per streamed reply, so two turns in one property
   *  cannot alias each other's fragments. */
  let streamSeq = 0

  const control: ConformanceControl = {
    askInteraction(sessionId, spec) {
      const server = serverFor(sessionId)
      const opencodeId = opencodeIdFor(sessionId)
      const ask = typeof spec === 'string' ? { kind: spec } : spec
      if (ask.kind === 'question') {
        const payload = 'payload' in ask ? ask.payload : undefined
        const prompts =
          payload && 'questions' in payload
            ? payload.questions.map((question) => ({
                question: question.question,
                header: question.header ?? 'Choice',
                options: question.options.map((option) => ({
                  label: option.label,
                  description: option.description ?? '',
                })),
              }))
            : [
                {
                  question: 'Which way?',
                  header: 'Direction',
                  options: [
                    { label: 'Left', description: 'go left' },
                    { label: 'Right', description: 'go right' },
                  ],
                },
              ]
        return server.askQuestion({ sessionID: opencodeId, questions: prompts })
      }
      /**
       * EVERY OTHER KIND ARRIVES AS A PERMISSION, AND THAT IS HONEST RATHER
       * THAN CONVENIENT.
       *
       * opencode's protocol has two ask channels — permission and question — and
       * this driver DECLARES exactly those two in its capabilities. The corpus
       * now asks in a kind the driver declares (POD-2023 changed the
       * phase-independence property to read the declaration), so a bare
       * `'permission'` and the declared-kind path both land here. A spec naming
       * a kind opencode has no channel for would be a corpus asking a driver to
       * fabricate an ask its harness cannot produce, and the fixture would
       * rather raise the nearest REAL channel than invent a fake one.
       */
      const payload = 'payload' in ask ? (ask.payload as Record<string, unknown>) : {}
      const toolName =
        typeof payload.toolName === 'string' ? payload.toolName.toLowerCase() : 'bash'
      return server.askPermission({
        sessionID: opencodeId,
        permission: toolName,
        patterns: ['echo hello'],
        metadata: { command: 'echo hello' },
        always: payload.canAlwaysAllow === true ? ['echo *'] : [],
      })
    },

    reaskInteraction(sessionId, previous) {
      // The server family does not claim `at-least-once`, so the corpus never
      // reaches this — but a duplicate ask is still what a re-ask MEANS, and
      // returning the same id would make a future property silently vacuous.
      void previous
      return control.askInteraction(sessionId, 'permission')
    },

    completeTurn(sessionId) {
      serverFor(sessionId).goIdle(opencodeIdFor(sessionId))
    },

    /**
     * THE RECORDED SHAPE, NOT A CONVENIENT ONE.
     *
     * Replayed from `__fixtures__/events-turn.json`, which is what opencode
     * 1.18.16 actually emitted for a two-token reply: the assistant message, an
     * EMPTY text part carrying `time:{start}`, the `message.part.delta` run, and
     * a closing `message.part.updated` carrying the whole text and
     * `time:{start,end}`.
     *
     * The closing time is the fixture detail that matters and the one a
     * hand-written stub would have left out. `stampOpencodeItems` puts
     * `time.end ?? time.start` in the cursor's `offset`, so the authoritative
     * item's cursor differs from every partial's — which is exactly how the
     * fragments came to carry an identity no consumer could join, and exactly
     * what this fixture makes the corpus able to see.
     */
    async streamAssistantText(sessionId, chunks) {
      const server = serverFor(sessionId)
      const opencodeId = opencodeIdFor(sessionId)
      const messageId = `msg_stream_${streamSeq++}`
      const partId = `prt_stream_${streamSeq++}`
      const start = Date.now()
      const requestedModel = server.lastPrompt(opencodeId)?.model
      server.emit('message.updated', {
        sessionID: opencodeId,
        info: {
          id: messageId,
          role: 'assistant',
          sessionID: opencodeId,
          time: { created: start },
          ...(requestedModel
            ? { providerID: requestedModel.providerID, modelID: requestedModel.modelID }
            : {}),
        },
      })
      const part = (text: string, time: Record<string, number>): Record<string, unknown> => ({
        type: 'text',
        text,
        messageID: messageId,
        sessionID: opencodeId,
        id: partId,
        time,
      })
      server.emit('message.part.updated', {
        sessionID: opencodeId,
        part: part('', { start }),
        time: start,
      })
      let text = ''
      for (const chunk of chunks) {
        text += chunk
        server.emit('message.part.delta', {
          sessionID: opencodeId,
          messageID: messageId,
          partID: partId,
          field: 'text',
          delta: chunk,
        })
      }
      // A field the driver must DROP, and an empty delta it must drop too —
      // both real arms of the protocol, and both silently forwarded before the
      // driver grew its filters.
      server.emit('message.part.delta', {
        sessionID: opencodeId,
        messageID: messageId,
        partID: partId,
        field: 'reasoning',
        delta: 'not text',
      })
      server.emit('message.part.delta', {
        sessionID: opencodeId,
        messageID: messageId,
        partID: partId,
        field: 'text',
        delta: '',
      })
      server.emit('message.part.updated', {
        sessionID: opencodeId,
        part: part(text, { start, end: start + 1 }),
        time: start + 1,
      })
      // The SSE hop is a real socket. Let the driver's reader drain it before
      // the corpus asks what it saw, or the assertion races the transport
      // rather than measuring the driver.
      await new Promise((resolve) => setTimeout(resolve, 20))
    },

    failTurn(sessionId) {
      serverFor(sessionId).emit('session.error', {
        sessionID: opencodeIdFor(sessionId),
        error: { name: 'ProviderError', message: 'fixture provider failure' },
      })
    },

    processEvent(sessionId, ev) {
      if (ev.ev !== 'exited') return
      const server = serverFor(sessionId)
      server.alive = false
      void server.close()
    },

    textDeliveries(sessionId) {
      // COUNTED WHERE THE WORDS ARRIVE: one accepted `prompt_async` POST is one
      // delivery of the caller's turn. That satisfies the counting rules on
      // `ConformanceControl.textDeliveries` without a change, and the reason is
      // structural rather than lucky — this driver POSTs at the DRAIN
      // (`drainQueue` → `deliver`), never at the queued `send()`, and it has no
      // native steer to miss.
      return serverFor(sessionId).promptCount(opencodeIdFor(sessionId))
    },

    failNextVerification(sessionId) {
      // There is NO verification window in this family — the 204 either happens
      // or it does not. The corpus pushes a driver at the `unverified` outcome
      // here, and a server driver must answer with something else; making the
      // POST fail is the only honest way to push.
      serverFor(sessionId).failNextPrompt()
    },

    model: {
      // `provider/model` is the only shape this family accepts — a bare id has
      // no provider to send it to and the driver drops it. The variant is the
      // effort, and it travels beside the model rather than inside it, so a
      // wake could lose either one alone.
      policy: () => ({ model: 'anthropic/claude-sonnet-4', effort: 'thinking' }),
      // KEEPS THE `provider/model` SHAPE. A bare id here would make the
      // configure properties fail for the reason the driver refuses it, not for
      // the reason they are testing.
      alternate: () => ({ model: 'anthropic/claude-opus-4-1', effort: 'high' }),
      // READ OFF THE SERVER: the prompt body it actually received.
      requested: (sessionId) => {
        const body = serverFor(sessionId).lastPrompt(opencodeIdFor(sessionId))
        if (!body) return undefined
        return {
          ...(body.model ? { model: `${body.model.providerID}/${body.model.modelID}` } : {}),
          ...(body.variant ? { effort: body.variant } : {}),
        }
      },
    },

    restartSupervisor() {
      // Handles die; the SERVERS do not. That is a daemon restart, and it is
      // what `adopt()` then has to find.
      for (const sessionId of [...servers.keys()]) runtime?.forget(sessionId)
    },

    connectWithoutSecret(sessionId) {
      // The cached result of a REAL credential-free request made at launch, to
      // this session's REAL listener. See `host.launch`.
      return { refused: secretRefused.get(sessionId) === true }
    },
  }

  return {
    observed,
    prompt: (sessionId) => serverFor(sessionId).lastPrompt(opencodeIdFor(sessionId)),
    failTurn: (sessionId) =>
      serverFor(sessionId).emit('session.error', {
        sessionID: opencodeIdFor(sessionId),
        error: { name: 'ProviderError', message: 'fixture provider failure' },
      }),
    /** The same channel with the error the caller names — `MessageAborted` is
     *  the one opencode sends for a cancelled turn (POD-2792). */
    emitSessionError: (sessionId: SessionId, error: { name: string; message: string }) =>
      serverFor(sessionId).emit('session.error', {
        sessionID: opencodeIdFor(sessionId),
        error,
      }),

    target: {
      name: 'opencode-server',
      family: 'server',
      createDriver: () => {
        runtime = createOpencodeRuntime(host)
        return { driver: runtime.driver, control }
      },
      reset: () => {
        runtime?.dispose()
        runtime = undefined
        for (const server of started.splice(0)) void server.close()
        servers.clear()
        // The store is per-WORLD, not per-server, but a property must not
        // inherit a previous property's conversations.
        store.clear()
        opencodeIds.clear()
        secretRefused.clear()
        entries.clear()
        seq = 0
      },
      spec: () => ({
        harness: 'opencode',
        selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
        workdir: '/tmp/conformance-opencode',
        model: {},
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
      }),
    },
  }
}

const { target } = makeWorld()

describe('opencode completed-turn configuration observation', () => {
  it('reports provider message fields without promoting the requested variant', async () => {
    const world = makeWorld()
    const { driver, control } = world.target.createDriver()
    try {
      const handle = await driver.create({
        ...world.target.spec(),
        model: { model: 'anthropic/claude-opus-4-1', effort: 'high' },
      })
      await handle.send(
        { text: 'use the configured pair' },
        { origin: 'human', delivery: 'when-ready' },
      )
      expect(world.observed).toEqual([])
      expect(world.prompt(handle.binding.sessionId)).toMatchObject({
        model: { providerID: 'anthropic', modelID: 'claude-opus-4-1' },
        variant: 'high',
      })

      await control.streamAssistantText(handle.binding.sessionId, ['done'])
      expect(world.observed).toEqual([])

      await control.completeTurn(handle.binding.sessionId)
      await vi.waitFor(() =>
        expect(world.observed).toEqual([
          {
            sessionId: handle.binding.sessionId,
            model: 'anthropic/claude-opus-4-1',
          },
        ]),
      )
    } finally {
      world.target.reset()
    }
  })
})

describe('opencode provider failure detail', () => {
  it('carries the provider text on the normalized state event', async () => {
    const world = makeWorld()
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())
      const events: RuntimeEvent[] = []
      const collect = (async () => {
        for await (const event of handle.events('bootstrap')) {
          events.push(event)
          if (event.t === 'state' && event.change.kind === 'turn_failed') break
        }
      })()
      await handle.send({ text: 'hello' }, { origin: 'human', delivery: 'when-ready' })
      world.failTurn(handle.binding.sessionId)
      await collect

      expect(
        events.find((event) => event.t === 'state' && event.change.kind === 'turn_failed'),
      ).toMatchObject({
        t: 'state',
        change: {
          kind: 'turn_failed',
          errorClass: 'provider-error',
          retryable: true,
          detail: expect.stringContaining('fixture provider failure'),
        },
      })
    } finally {
      world.target.reset()
    }
  })

  /**
   * ASSERT ON WHAT THE DAEMON ACTUALLY SHIPS (POD-2811).
   *
   * The test above passed throughout the bug it was written to catch. It reads
   * the EVENT, and the badge is not the event: the daemon answers every `state`
   * frame by calling `handle.state()` and sending THAT
   * (`apps/daemon/src/runtime/opencode-driver.ts` — "the driver's own folded
   * projection"). `closeTurn` emitted `turn_failed` carrying the reason and
   * opencode's own error text, then overwrote the projection with a bare
   * `{ phase: 'errored' }`.
   *
   * MEASURED ON A REAL PROVIDER, not imagined: a session on
   * `opencode/laguna-s-2.1-free`, retired from opencode's gateway, went red in
   * 10.2s and read `errorClass=(none) detail=(none)` for the next three minutes.
   * Red with nothing to say is barely better than silence.
   */
  it('leaves the badge errored, with the class and detail an operator can read', async () => {
    const world = makeWorld()
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())
      const events: RuntimeEvent[] = []
      const collect = (async () => {
        for await (const event of handle.events('bootstrap')) {
          events.push(event)
          if (event.t === 'state' && event.change.kind === 'turn_failed') break
        }
      })()
      await handle.send({ text: 'hello' }, { origin: 'human', delivery: 'when-ready' })
      world.failTurn(handle.binding.sessionId)
      await collect

      expect(await handle.state()).toMatchObject({
        phase: 'errored',
        error: {
          class: 'provider-error',
          retryable: true,
          detail: expect.stringContaining('fixture provider failure'),
        },
      })
      // The snapshot a rebind reads agrees with the badge.
      expect((await handle.snapshot()).state).toMatchObject({
        phase: 'errored',
        error: { class: 'provider-error' },
      })
    } finally {
      world.target.reset()
    }
  })
})
/**
 * AN ABORTED TURN IS INTERRUPTED, NOT BROKEN (POD-2792).
 *
 * opencode signals a cancelled turn as `session.error` with `MessageAborted`,
 * and this driver classified it as `interrupted` and then closed the turn as
 * FAILED anyway — so a session the operator stopped went to `phase: errored`
 * carrying no error at all, while codex reached `idle` from the same button.
 * Nothing covered the mapping: `MessageAborted` appeared exactly once in this
 * package, in the classifier, and no test named it.
 */
describe('an aborted opencode turn', () => {
  const abortTurn = (world: ReturnType<typeof makeWorld>, sessionId: SessionId) =>
    world.emitSessionError(sessionId, {
      name: 'MessageAborted',
      message: 'the turn was aborted',
    })

  it('closes as completed with the interrupted verdict, never as a failure', async () => {
    const world = makeWorld()
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())
      const events: RuntimeEvent[] = []
      const collect = (async () => {
        for await (const event of handle.events('bootstrap')) {
          events.push(event)
          if (event.t === 'state' && event.change.kind === 'turn_completed') break
          if (event.t === 'state' && event.change.kind === 'turn_failed') break
        }
      })()
      await handle.send({ text: 'a long task' }, { origin: 'human', delivery: 'when-ready' })
      abortTurn(world, handle.binding.sessionId)
      await collect

      // The VERDICT, from the provider's own word for what happened.
      expect(
        events.find((event) => event.t === 'state' && event.change.kind === 'turn_completed'),
      ).toMatchObject({
        t: 'state',
        change: { kind: 'turn_completed', verdict: { kind: 'interrupted' } },
      })
      // And nothing that would paint the session as errored.
      expect(
        events.filter((event) => event.t === 'state' && event.change.kind === 'turn_failed'),
      ).toEqual([])
      expect(events.filter((event) => event.t === 'turn' && event.ev.ev === 'failed')).toEqual([])
    } finally {
      world.target.reset()
    }
  })

  /**
   * THE MARK A STOPPED TURN LEAVES BEHIND (POD-3090).
   *
   * The verdict above is what the MACHINE reads. This is what a human reading
   * the conversation back reads, and headless it did not exist: the turn stopped
   * mid-sentence and the transcript said nothing, while a terminal session shows
   * the stop rule Claude Code's own marker earns it. The fence now mints the
   * mark from the same terminal result the verdict comes from.
   */
  it('leaves exactly one durable interrupt item, stable across a replay', async () => {
    const world = makeWorld()
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())
      const events: RuntimeEvent[] = []
      void (async () => {
        try {
          for await (const event of handle.events('bootstrap')) events.push(event)
        } catch {
          // the stream ends with the session
        }
      })()
      await handle.send({ text: 'a long task' }, { origin: 'human', delivery: 'when-ready' })
      abortTurn(world, handle.binding.sessionId)

      const marks = (collected: RuntimeEvent[]): TranscriptItem[] =>
        collected.flatMap((event) =>
          event.t === 'item' &&
          event.item.kind === 'complete' &&
          event.item.item.event === 'interrupt'
            ? [event.item.item]
            : [],
        )

      await vi.waitFor(() => expect(marks(events)).toHaveLength(1))
      expect(marks(events)[0]).toMatchObject({
        id: `opencode-interrupt-${handle.binding.sessionId}-1`,
        role: 'user',
        text: '[Request interrupted by user]',
        event: 'interrupt',
      })

      // A SECOND terminal signal for the same turn — the duplicate a flaky SSE
      // reconnect delivers. The epoch fence absorbs it and the id would collapse
      // it anyway; either way the operator sees one stop.
      abortTurn(world, handle.binding.sessionId)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(marks(events)).toHaveLength(1)

      // The reload seam: a fresh reader of the same stream sees the same one.
      const replayed: RuntimeEvent[] = []
      void (async () => {
        try {
          for await (const event of handle.events('bootstrap')) replayed.push(event)
        } catch {
          // the stream ends with the session
        }
      })()
      await vi.waitFor(() => expect(marks(replayed)).toHaveLength(1))
      expect(marks(replayed)[0]?.id).toBe(marks(events)[0]?.id)
    } finally {
      world.target.reset()
    }
  })

  it('leaves the session idle and takeable, not stuck at working', async () => {
    const world = makeWorld()
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())
      await handle.send({ text: 'a long task' }, { origin: 'human', delivery: 'when-ready' })
      await vi.waitFor(async () => expect((await handle.snapshot()).state.phase).toBe('working'))

      abortTurn(world, handle.binding.sessionId)

      await vi.waitFor(async () => expect((await handle.snapshot()).state.phase).toBe('idle'))
    } finally {
      world.target.reset()
    }
  })
})
describe('attachment file-part prompts', () => {
  it('returns a raw typed staging failure', async () => {
    const world = makeWorld({
      stageAttachment: async () => {
        throw new Error('disk full')
      },
    })
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())
      await expect(
        handle.stageAttachment({
          bytes: new TextEncoder().encode('notes'),
          filename: 'notes.txt',
          mediaType: 'text/plain',
        }),
      ).resolves.toEqual({ reason: 'staging_failed', detail: 'Error: disk full' })
    } finally {
      world.target.reset()
    }
  })

  it('sends staged files as opencode file parts', async () => {
    const world = makeWorld()
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())
      const staged = await handle.stageAttachment({
        bytes: new TextEncoder().encode('notes'),
        filename: 'notes.txt',
        mediaType: 'text/plain',
      })
      if ('reason' in staged) throw new Error(staged.detail ?? staged.reason)
      await handle.send(
        { text: 'read this', attachments: [staged] },
        { origin: 'human', delivery: 'when-ready' },
      )
      const url = new URL('file:///')
      url.pathname = staged.path
      expect(world.prompt(handle.binding.sessionId)?.parts).toEqual([
        { type: 'text', text: 'read this' },
        {
          type: 'file',
          mime: 'text/plain',
          filename: 'notes.txt',
          url: url.href,
        },
      ])
    } finally {
      world.target.reset()
    }
  })
})

/**
 * THE OTHER ARM OF THE SAME PROPERTY, ON A HOST THAT HOSTS NO TERMINAL.
 *
 * `assertAttachHonoursOneControlLease` classifies every answer before judging it
 * and then branches: an endpoint must be of a kind the capability DECLARES, and
 * a refusal must be TYPED — and a refused attach must not be holding the lease.
 * The run above takes the ENDPOINT branch from its first `peek` and never comes
 * back, which is correct for a machine that can host a client and is exactly why
 * the refusal branch had no landed target reaching it.
 *
 * So the refusal arm gets the world it describes rather than a flag inside the
 * other one: same real driver, same real loopback server, one host fact changed.
 * The corpus's own property does the judging — this file only supplies the
 * machine — which is what keeps the assertion shared rather than re-stated here.
 *
 * WHY NOT A SECOND FULL `runConformance`. Nothing else in the corpus reads
 * `attachClient`, so a second whole-corpus pass would re-prove ~90 properties to
 * reach one branch. The suite exports this assertion for precisely this — see
 * its own note about the teeth tests.
 *
 * WHAT THIS STILL DOES NOT REACH, SAID PLAINLY, because this file's own thesis
 * is that undocumented dormancy is what goes stale. The refusal arm has two
 * assertions and only the weaker one runs here. A refused PEEK is judged for a
 * TYPED reason and for leaving the lease alone — but no mode-guarded
 * implementation can fail the second, since a peek never touches the lease. The
 * assertion with real teeth is the refused TAKEOVER ("a refused take-over kept
 * the control lease"), and this world cannot reach it:
 * `assertAttachHonoursOneControlLease` returns at the refused peek and never
 * asks for a takeover.
 *
 * Reaching it needs a host that hosts a SPECTATOR STREAM but no control
 * terminal, so the peek succeeds and only the takeover is refused — the shape
 * `attachLease: 'refuses-after-taking'` drives in `fake.test.ts:291`. That host
 * is the `describe` below (POD-2131), and it is where this driver's refused
 * take-over is judged; this world stops at the classification.
 */
describe('opencode-server on a host with nowhere to run a terminal', () => {
  it('refuses the attach, typed, and does not walk off with the lease', async () => {
    const world = makeWorld({ hostsClientTerminals: false })
    const { driver } = world.target.createDriver()
    try {
      const handle = await driver.create(world.target.spec())

      /**
       * THE ARM IS PINNED BEFORE THE PROPERTY RUNS, because the property is
       * satisfied by EITHER arm and would go green on this world without ever
       * reaching the refusal branch — which is the exact failure that made the
       * branch dormant in the first place, reproduced one level up. These two
       * assertions are what make the test below about the refusal.
       *
       * `supported` stays TRUE: this is a declared attach being refused by a
       * particular machine, not a family that has no terminal. The two reach
       * different branches of the property — the declared-gap arm asserts the
       * family may have no attach at all, and would say nothing about a machine
       * that simply cannot host one today.
       *
       * What the pin buys, exactly: it forces the classification path — a
       * refusal must be TYPED — to run. It does NOT reach the ordering
       * invariant; see the block above this `describe` for why, and for what
       * would.
       */
      expect(driver.capabilities().attach.supported).toBe(true)
      expect(await handle.attach({ mode: 'peek', holder: 'probe' })).toMatchObject({
        reason: 'unsupported',
      })

      await assertAttachHonoursOneControlLease(handle, driver.capabilities(), world.target.family)
    } finally {
      world.target.reset()
    }
  })
})

/**
 * THE HALF WITH THE TEETH: A REFUSED TAKE-OVER IS NOT HOLDING THE LEASE
 * (POD-2131; the invariant is POD-2059's, the assertion is POD-2085's).
 *
 * ---------------------------------------------------------------------------
 * THE MACHINE
 * ---------------------------------------------------------------------------
 *
 * A box that can pipe a read-only stream to watchers and has no seat to put a
 * controlling human in. Peek succeeds, take-over is refused — and that ordering
 * is the whole point, because `assertAttachHonoursOneControlLease` RETURNS at a
 * refused peek. The world above refuses everything, so it never gets as far as
 * asking for control; every other landed fixture hosts both, so it takes the
 * endpoint branch and never refuses at all. This is the only host shape under
 * which a real driver is asked the question at all — the same shape the corpus's
 * own teeth test drives against a fake as `attachLease: 'refuses-after-taking'`.
 *
 * WHAT IT BUYS OVER THAT TEETH TEST, since the two look alike from a distance.
 * The teeth test proves the ASSERTION bites, using a fake built to fail it. It
 * says nothing about opencode. This says the invariant holds in the driver that
 * broke it: a refusal for want of a terminal host is correct, and doing it while
 * holding the lease would leave an orphaned controller on a session the caller
 * was just refused control of.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES IT RED, MEASURED — AND A CORRECTION TO THIS ISSUE'S BRIEF
 * ---------------------------------------------------------------------------
 *
 * The brief said to verify by moving the guarded lease assignment ABOVE the
 * `attachClient` call and watching this go red. That mutation is a no-op today:
 * the code already does exactly that. `52781e293` moved the assignment ahead of
 * the await ON PURPOSE, to close a race in which two take-overs both won while
 * the first was still starting its client (`lease.test.ts`, "reserves the lease
 * before awaiting client startup"). The lease is now RESERVED before the client
 * is started and ROLLED BACK if the host produces none.
 *
 * So the ordering half of POD-2059's fix is no longer carried by the ordering.
 * It is carried by that rollback, and the rollback is what this test pins.
 * Deleting the `session.lease = previousLease` line in `attach`'s `!client`
 * branch — a driver that reserved the lease, found no terminal, and refused
 * anyway — leaves the whole rest of the package green and turns exactly this
 * test red, on `suite.ts`'s own "a refused take-over kept the control lease".
 * That mutation was run, and reverted.
 */
describe('opencode-server on a host that streams to watchers but seats no controller', () => {
  it('refuses the take-over without walking off with the lease', async () => {
    const world = makeWorld({ hostsClientTerminals: 'spectators-only' })
    const { driver } = world.target.createDriver()
    try {
      /**
       * THE ARM IS PINNED ON A SESSION OF ITS OWN, and the separate session is
       * the load-bearing part rather than tidiness.
       *
       * The pin has to establish that on this world a peek yields an ENDPOINT
       * and a take-over is REFUSED — without which the property would be
       * satisfied through the endpoint branch and prove nothing, the failure
       * that kept this arm dormant in the first place. But the pin's own
       * take-over is the very call under test, and a driver with the bug would
       * leave the lease taken behind it. Pinning on the judged session would
       * then hand the property a poisoned starting state: it reads the lease
       * BEFORE its own take-over and compares the two, so a lease already
       * wrongly held reads as "unchanged" and the bug passes. Measured, not
       * reasoned — under the mutation named above this `describe`, the
       * one-session version of this test is GREEN.
       *
       * Two fresh sessions on one host answer that: the pin is a statement about
       * the MACHINE — which the host decides per call, off `input.mode` alone —
       * and the judged session reaches the property untouched.
       */
      const probe = await driver.create(world.target.spec())
      expect(driver.capabilities().attach.supported).toBe(true)
      expect('kind' in (await probe.attach({ mode: 'peek', holder: 'probe' }))).toBe(true)
      expect(await probe.attach({ mode: 'takeover', holder: 'probe' })).toMatchObject({
        reason: 'unsupported',
      })

      const handle = await driver.create(world.target.spec())
      await assertAttachHonoursOneControlLease(handle, driver.capabilities(), world.target.family)
    } finally {
      world.target.reset()
    }
  })
})

runConformance(target.createDriver, {
  name: target.name,
  family: target.family,
  reset: target.reset,
  spec: target.spec,
  /**
   * THE CLAIM THE SUITE CHECKS BEFORE IT RUNS A SINGLE PROPERTY. It must equal
   * the server family's row exactly — so this driver fails both by claiming a
   * weakness the family does not permit and by exhibiting one it did not claim.
   */
  exemptions: SERVER_PERMITTED_FAILURES,
})
