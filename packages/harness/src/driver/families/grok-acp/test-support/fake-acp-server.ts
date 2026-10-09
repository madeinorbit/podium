import type { GrokAcpTransport } from '../client.js'

interface Handler {
  line(line: string): void
  closed(): void
}

/** One update as Grok stores it: the update, and the `promptId` of the turn it
 *  belongs to (none for a user record, which Grok writes before the turn's
 *  first stamped update). */
export interface FakeGrokStoredUpdate {
  update: Record<string, unknown>
  promptId?: string
}

export interface FakeGrokAcpServerOptions {
  /** Test-only bridge from a replayed wire result to the runtime settlement
   *  callback whose absorbing epoch guard the conformance corpus exercises. */
  onReplayedPromptResult?(): void
  /**
   * THE CONVERSATION STORE, WHICH OUTLIVES THE AGENT PROCESS (POD-2703,
   * review 1).
   *
   * Grok keeps its sessions in its own store, which is why `session/load`
   * exists at all: a fresh `grok --acp` is told a session id and REPLAYS that
   * conversation to the client as `session/update` notifications. This fixture
   * replayed nothing, so a loaded session came back with an empty
   * `transcriptItems` and the driver's own `'replay'` provenance branch — which
   * it has, at runtime.ts's ingest — was dead code no test ever entered.
   *
   * That made the corpus's resume properties unfalsifiable on this family: a
   * resumed session was byte-identical to a fresh one, so a mutant that
   * discarded the ref passed. Pass ONE map across every server a world starts
   * and the fixture describes the harness Grok actually is.
   *
   * Omitted, the server keeps its own — right for the many tests that start
   * exactly one and never load.
   */
  store?: Map<string, FakeGrokStoredUpdate[]>
  /** Exact notification frames appended to the provider update log. */
  frameStore?: Map<string, Record<string, unknown>[]>
  /** Hold `session/cancel` open until the test supplies the prompt result. The
   *  production protocol separates the cancellation request from its fence;
   *  this option lets a test prove the driver does too. */
  deferCancellation?: boolean
  /** Also send the prompt's `user_message_chunk` live, as Grok 0.2.x did. Grok
   *  1.0.44 records it but never sends it to the client (measured, POD-4837),
   *  so this is off by default. */
  echoPrompt?: boolean
  /** Name each prompt in `_x.ai/queue/changed` as Grok 1.0.44 does: queued,
   *  then running (default). Off models a build that sends no queue frames;
   *  `hold` waits for {@link FakeGrokAcpServer.ackPrompt}. */
  ackPrompt?: boolean | 'hold'
  /** A `UserPromptSubmit` hook is configured: the prompt is recorded only once
   *  {@link FakeGrokAcpServer.runPromptHook} lets it through. */
  promptHook?: boolean
}

export interface FakeGrokAcpServer {
  transport: GrokAcpTransport
  alive: boolean
  sessionId: string
  promptCount: number
  /** Every `session/prompt` request's params, in order. */
  prompts: Record<string, unknown>[]
  /** Every `session/new` request's params, in order. */
  sessionNews: Record<string, unknown>[]
  /** The prompt Grok is running, by its `promptId`. */
  runningPromptId: string | undefined
  /** `session/cancel` notifications received. */
  cancels: number
  answers: Map<string | number, unknown>
  /** Send the held queue ack for the running prompt (`ackPrompt: 'hold'`):
   *  both frames, as Grok does, or only the queued entry (Grok holding the
   *  prompt behind a turn of its own) or only the running frame. */
  ackPrompt(stage?: 'both' | 'queued' | 'running'): void
  /** One update stamped with the running prompt's id, as Grok sends it. */
  pushStampedUpdate(
    update: Record<string, unknown>,
    method?: 'session/update' | '_x.ai/session_notification',
  ): void
  /** The `UserPromptSubmit` hook's verdict (`promptHook`): `allow` records the
   *  prompt, `block` ends the turn `cancelled` as `HookDenied`, unrecorded. */
  runPromptHook(verdict: 'allow' | 'block'): void
  askPermission(): string
  /** One assistant reply, chunk by chunk, exactly as grok streams it: a run of
   *  `agent_message_chunk` updates under monotonic `_meta.eventId`s. The item
   *  itself is not pushed — this family flushes its buffer at the fence, which
   *  is the behaviour the corpus is there to hold. */
  streamAgentText(chunks: readonly string[]): void
  /** Replay the most recent provider update with the same wire identity. */
  replayLastUpdate(): void
  toolCall(input: {
    toolCallId: string
    title?: string
    rawInput?: Record<string, unknown>
    kind?: string
  }): void
  toolCallUpdate(input: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    content?: unknown
    rawOutput?: unknown
  }): void
  completeTurn(stopReason?: 'end_turn' | 'cancelled' | 'refusal'): void
  failProviderTurn(detail: string): void
  failProviderAttempt(detail: string): void
  /** Answer the next `session/prompt` with a JSON-RPC error. By default Grok
   *  never names it (a rejected request); `afterAck` names and records it first,
   *  as grok 1.0.44 does when the provider call fails (measured: a 402). */
  failNextPrompt(detail?: string, options?: { afterAck?: boolean }): void
  crash(): void
}

export function startFakeGrokAcpServer(
  // Reassigned by `session/load`: the server serves whichever conversation it
  // was asked to load, not the one it happened to mint at startup.
  // biome-ignore lint/style/noParameterAssign: modelling a real load is the point
  sessionId = 'grok-native-1',
  options: FakeGrokAcpServerOptions = {},
): FakeGrokAcpServer {
  let handler: Handler | undefined
  const buffered: string[] = []
  let nextServerId = 100
  let pendingPrompt: string | number | undefined
  let lastPromptResult:
    | { id: string | number; result: { stopReason: 'end_turn' | 'cancelled' | 'refusal' } }
    | undefined
  let failNext = false
  let failNextAfterAck = false
  let failNextDetail = 'fixture prompt failure'
  let eventSeq = 0
  let mintedPromptIds = 0
  let heldAck: { promptId: string; text: string } | undefined
  let lastNotificationFrame: Record<string, unknown> | undefined
  const store = options.store ?? new Map<string, FakeGrokStoredUpdate[]>()
  const recorded = (id: string): FakeGrokStoredUpdate[] => store.get(id) ?? []

  const push = (frame: unknown): void => {
    const line = JSON.stringify(frame)
    if (handler) handler.line(line)
    else buffered.push(line)
  }
  const response = (id: string | number, result: unknown): void =>
    push({ jsonrpc: '2.0', id, result })
  /** Everything the client is told about a session is also what a later
   *  `session/load` must be able to replay — so recording happens here, at the
   *  one place updates leave the server. */
  const notifyUpdate = (
    update: Record<string, unknown>,
    method: 'session/update' | '_x.ai/session_notification' = 'session/update',
    delivery: { live?: boolean; meta?: Record<string, unknown> } = {},
  ): void => {
    // Grok 1.0.44 stamps every update of a turn with the turn's promptId,
    // except the user record it writes at the turn's start (measured).
    const promptId =
      update.sessionUpdate === 'user_message_chunk' ? undefined : server.runningPromptId
    const log = store.get(sessionId) ?? []
    log.push({ update, ...(promptId !== undefined ? { promptId } : {}) })
    store.set(sessionId, log)
    eventSeq += 1
    const frame: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      params: {
        sessionId,
        update,
        _meta: {
          eventId: `${sessionId}-${eventSeq}`,
          agentTimestampMs: 1_786_700_000_000 + eventSeq,
          ...(promptId !== undefined && method === 'session/update' ? { promptId } : {}),
          ...delivery.meta,
        },
      },
    }
    const frames = options.frameStore?.get(sessionId) ?? []
    frames.push(frame)
    options.frameStore?.set(sessionId, frames)
    if (delivery.live === false) return
    lastNotificationFrame = frame
    push(frame)
  }
  const queueChanged = (params: Record<string, unknown>): void =>
    push({ jsonrpc: '2.0', method: '_x.ai/queue/changed', params: { sessionId, ...params } })
  const sendAck = (
    promptId: string,
    text: string,
    stage: 'both' | 'queued' | 'running' = 'both',
  ): void => {
    if (stage !== 'running') {
      queueChanged({
        entries: [{ id: promptId, version: 0, kind: 'prompt', text, position: 0 }],
      })
    }
    if (stage === 'queued') return
    queueChanged({
      entries: [],
      runningPromptId: promptId,
      runningText: text,
      runningKind: 'prompt',
    })
  }
  /** The user record Grok writes once the prompt passed its hooks. */
  const recordPrompt = (text: string): void =>
    notifyUpdate(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
      'session/update',
      { live: options.echoPrompt === true },
    )
  let pendingText = ''
  const promptResult = (stopReason: string): Record<string, unknown> => ({
    stopReason,
    ...(server.runningPromptId !== undefined
      ? { _meta: { promptId: server.runningPromptId, requestId: server.runningPromptId } }
      : {}),
  })

  const server: FakeGrokAcpServer = {
    transport: {
      write(line) {
        const frame = JSON.parse(line) as {
          id?: string | number
          method?: string
          params?: Record<string, unknown>
          result?: unknown
        }
        if (frame.method && frame.id !== undefined) {
          switch (frame.method) {
            case 'initialize':
              response(frame.id, {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true },
              })
              return
            case 'session/new':
              server.sessionNews.push(frame.params ?? {})
              response(frame.id, { sessionId })
              return
            case 'session/load': {
              /**
               * THE SERVER TAKES ON THE SESSION IT IS ASKED TO LOAD (POD-2703).
               *
               * `session/load` used to answer with the id this fixture minted at
               * startup and ignore the one in the request. That is not what a
               * load is: the conversation is Grok's, it outlived the agent
               * process, and a fresh `grok --acp` asked to load `X` serves `X`
               * afterwards — its own startup id is not a thing the client ever
               * knew about.
               *
               * Nothing noticed until `resume()` came under the corpus, because
               * every other path here loads the id the same server minted, so
               * the two were equal by accident. On the resume path they are not:
               * the driver addresses the ref it was given, and every
               * `session/update` this fixture pushed carried a DIFFERENT
               * `sessionId`, so the driver — correctly — dropped them all and
               * the resumed session went silent.
               */
              const requested = frame.params?.sessionId
              if (typeof requested === 'string' && requested.length > 0) {
                sessionId = requested
                server.sessionId = requested
              }
              /**
               * AND IT REPLAYS THE CONVERSATION, WHICH IS WHAT A LOAD IS FOR
               * (POD-2703, review 1).
               *
               * ACP's `session/load` streams the session's history back as
               * `session/update` notifications before it answers, and the driver
               * ingests them under `'replay'` provenance — a branch it has had
               * since W-grok and that no test ever entered, because this fixture
               * answered the call and sent nothing. A loaded session therefore
               * came back EMPTY, and every corpus property that asked only about
               * the ref was happy with it.
               *
               * The replay goes out BEFORE the response, which is both the
               * protocol's order and the one the driver depends on: it holds
               * `session.loading` across the call, so an update arriving after
               * the response would be mis-stamped `live`.
               */
              for (const { update, promptId } of recorded(sessionId)) {
                eventSeq += 1
                push({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId,
                    update,
                    _meta: {
                      eventId: `${sessionId}-replay-${eventSeq}`,
                      agentTimestampMs: 1_786_700_000_000 + eventSeq,
                      ...(promptId !== undefined ? { promptId } : {}),
                      isReplay: true,
                    },
                  },
                })
              }
              response(frame.id, { sessionId })
              return
            }
            case 'session/set_mode':
              response(frame.id, {})
              return
            case 'session/prompt': {
              server.promptCount += 1
              server.prompts.push(frame.params ?? {})
              if (failNext) {
                failNext = false
                if (failNextAfterAck) {
                  const meta = frame.params?._meta as { promptId?: unknown } | undefined
                  const promptId =
                    typeof meta?.promptId === 'string'
                      ? meta.promptId
                      : `fake-prompt-${++mintedPromptIds}`
                  const prompt = frame.params?.prompt as { text?: unknown }[] | undefined
                  const text = String(prompt?.[0]?.text ?? '')
                  sendAck(promptId, text)
                  server.runningPromptId = promptId
                  recordPrompt(text)
                  server.runningPromptId = undefined
                }
                push({
                  jsonrpc: '2.0',
                  id: frame.id,
                  error: { code: 402, message: failNextDetail },
                })
                return
              }
              pendingPrompt = frame.id
              const prompt = frame.params?.prompt
              const text =
                Array.isArray(prompt) &&
                typeof prompt[0] === 'object' &&
                prompt[0] !== null &&
                'text' in prompt[0]
                  ? String(prompt[0].text)
                  : ''
              const meta = frame.params?._meta
              const ours =
                typeof meta === 'object' && meta !== null && 'promptId' in meta
                  ? meta.promptId
                  : undefined
              // A client that supplies its own promptId owns it; otherwise
              // Grok mints one per turn.
              server.runningPromptId =
                typeof ours === 'string' && ours ? ours : `fake-prompt-${++mintedPromptIds}`
              pendingText = text
              if (options.ackPrompt === 'hold') {
                heldAck = { promptId: server.runningPromptId, text }
              } else if (options.ackPrompt !== false) {
                sendAck(server.runningPromptId, text)
              }
              if (!options.promptHook) recordPrompt(text)
              return
            }
            default:
              push({
                jsonrpc: '2.0',
                id: frame.id,
                error: { code: -32601, message: 'method not found' },
              })
              return
          }
        }
        if (frame.method === 'session/cancel') {
          server.cancels += 1
          if (!options.deferCancellation) server.completeTurn('cancelled')
          return
        }
        if (frame.id !== undefined && !frame.method) {
          server.answers.set(frame.id, frame.result)
        }
      },
      onLine(next) {
        handler = next
        for (const line of buffered.splice(0)) next.line(line)
      },
      close() {
        // The client closing stdin does not synthesize a provider crash.
      },
    },
    alive: true,
    sessionId,
    promptCount: 0,
    prompts: [],
    sessionNews: [],
    runningPromptId: undefined,
    cancels: 0,
    answers: new Map(),
    ackPrompt(stage = 'both') {
      const held = heldAck
      heldAck = undefined
      if (held) sendAck(held.promptId, held.text, stage)
    },
    pushStampedUpdate(update, method = 'session/update') {
      notifyUpdate(
        update,
        method,
        server.runningPromptId !== undefined && method !== 'session/update'
          ? { meta: { promptId: server.runningPromptId } }
          : {},
      )
    },
    runPromptHook(verdict) {
      const promptId = server.runningPromptId
      const id = pendingPrompt
      if (promptId === undefined || id === undefined) return
      const blocked = verdict === 'block'
      notifyUpdate(
        {
          sessionUpdate: 'hook_execution',
          event_name: 'user_prompt_submit',
          prompt_id: promptId,
          runs: [
            {
              name: 'global/probe:user_prompt_submit[0].hooks[0]',
              status: blocked
                ? { status: 'failed', error: 'blocked: fixture', elapsed_ms: 18, blocked: true }
                : { status: 'success', elapsed_ms: 16 },
            },
          ],
        },
        '_x.ai/session_notification',
      )
      if (!blocked) {
        recordPrompt(pendingText)
        return
      }
      // A blocked prompt is never recorded: the turn ends `cancelled`.
      notifyUpdate(
        { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'cancelled' },
        '_x.ai/session_notification',
        {
          meta: {
            cancellationCategory: 'HookDenied',
            cancellationContext: { reason: 'blocked: fixture' },
          },
        },
      )
      pendingPrompt = undefined
      const result = promptResult('cancelled') as { stopReason: 'cancelled' }
      lastPromptResult = { id, result }
      response(id, result)
      server.runningPromptId = undefined
    },
    askPermission() {
      const id = nextServerId++
      push({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: `tool-${id}`,
            kind: 'execute',
            title: 'Run command',
            rawInput: { command: 'pwd' },
          },
          options: [
            { optionId: `allow-${id}`, name: 'Allow', kind: 'allow_once' },
            { optionId: `always-${id}`, name: 'Always', kind: 'allow_always' },
            { optionId: `deny-${id}`, name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      return String(id)
    },
    streamAgentText(chunks) {
      for (const chunk of chunks) {
        notifyUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk },
        })
      }
    },
    replayLastUpdate() {
      if (lastNotificationFrame !== undefined) push(lastNotificationFrame)
    },

    toolCall(input) {
      notifyUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: input.toolCallId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.rawInput !== undefined ? { rawInput: input.rawInput } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      })
    },
    toolCallUpdate(input) {
      notifyUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: input.toolCallId,
        status: input.status,
        ...(Object.prototype.hasOwnProperty.call(input, 'content')
          ? { content: input.content }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(input, 'rawOutput')
          ? { rawOutput: input.rawOutput }
          : {}),
      })
    },
    completeTurn(stopReason = 'end_turn') {
      const replayed = pendingPrompt === undefined
      const id = pendingPrompt ?? lastPromptResult?.id
      if (id === undefined) return
      pendingPrompt = undefined
      if (!replayed && stopReason === 'end_turn') {
        notifyUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        })
      }
      const result = replayed
        ? (lastPromptResult?.result ?? { stopReason })
        : (promptResult(stopReason) as { stopReason: typeof stopReason })
      lastPromptResult = { id, result }
      response(id, result)
      if (!replayed) server.runningPromptId = undefined
      if (replayed) options.onReplayedPromptResult?.()
    },
    failProviderTurn(detail) {
      const id = pendingPrompt
      if (id === undefined) return
      pendingPrompt = undefined
      notifyUpdate(
        {
          sessionUpdate: 'retry_state',
          type: 'failed',
          error_type: 'api',
          message: detail,
        },
        '_x.ai/session_notification',
      )
      notifyUpdate(
        {
          sessionUpdate: 'hook_execution',
          event_name: 'stop_failure',
        },
        '_x.ai/session_notification',
      )
      notifyUpdate(
        {
          sessionUpdate: 'turn_completed',
          ...(server.runningPromptId !== undefined ? { prompt_id: server.runningPromptId } : {}),
          stop_reason: 'error',
          agent_result: detail,
        },
        '_x.ai/session_notification',
      )
      const result = promptResult('refusal') as { stopReason: 'refusal' }
      lastPromptResult = { id, result }
      response(id, result)
      server.runningPromptId = undefined
    },
    failProviderAttempt(detail) {
      if (pendingPrompt === undefined) return
      notifyUpdate(
        {
          sessionUpdate: 'retry_state',
          type: 'failed',
          error_type: 'api',
          message: detail,
        },
        '_x.ai/session_notification',
      )
    },
    failNextPrompt(detail = 'fixture prompt failure', failure = {}) {
      failNext = true
      failNextAfterAck = failure.afterAck === true
      failNextDetail = detail
    },
    crash() {
      if (!server.alive) return
      server.alive = false
      handler?.closed()
    },
  }
  return server
}
