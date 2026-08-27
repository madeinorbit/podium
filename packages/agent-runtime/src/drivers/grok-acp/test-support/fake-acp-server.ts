import type { GrokAcpTransport } from '../client.js'

interface Handler {
  line(line: string): void
  closed(): void
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
  store?: Map<string, Record<string, unknown>[]>
  /** Hold `session/cancel` open until the test supplies the prompt result. The
   *  production protocol separates the cancellation request from its fence;
   *  this option lets a test prove the driver does too. */
  deferCancellation?: boolean
}

export interface FakeGrokAcpServer {
  transport: GrokAcpTransport
  alive: boolean
  sessionId: string
  promptCount: number
  answers: Map<string | number, unknown>
  askPermission(): string
  /** One assistant reply, chunk by chunk, exactly as grok streams it: a run of
   *  `agent_message_chunk` updates under monotonic `_meta.eventId`s. The item
   *  itself is not pushed — this family flushes its buffer at the fence, which
   *  is the behaviour the corpus is there to hold. */
  streamAgentText(chunks: readonly string[]): void
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
  failNextPrompt(detail?: string): void
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
  let failNextDetail = 'fixture prompt failure'
  let eventSeq = 0
  const store = options.store ?? new Map<string, Record<string, unknown>[]>()
  const recorded = (id: string): Record<string, unknown>[] => store.get(id) ?? []

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
  ): void => {
    const log = store.get(sessionId) ?? []
    log.push(update)
    store.set(sessionId, log)
    eventSeq += 1
    push({
      jsonrpc: '2.0',
      method,
      params: {
        sessionId,
        update,
        _meta: {
          eventId: `${sessionId}-${eventSeq}`,
          agentTimestampMs: 1_786_700_000_000 + eventSeq,
        },
      },
    })
  }

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
              for (const update of recorded(sessionId)) {
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
              if (failNext) {
                failNext = false
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
              notifyUpdate({
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text },
              })
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
    answers: new Map(),
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
      const result = replayed ? (lastPromptResult?.result ?? { stopReason }) : { stopReason }
      lastPromptResult = { id, result }
      response(id, result)
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
          stop_reason: 'error',
          agent_result: detail,
        },
        '_x.ai/session_notification',
      )
      const result = { stopReason: 'refusal' as const }
      lastPromptResult = { id, result }
      response(id, result)
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
    failNextPrompt(detail = 'fixture prompt failure') {
      failNext = true
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
