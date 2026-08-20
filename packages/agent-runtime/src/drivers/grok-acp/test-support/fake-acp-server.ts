import type { GrokAcpTransport } from '../client.js'

interface Handler {
  line(line: string): void
  closed(): void
}

export interface FakeGrokAcpServerOptions {
  /** Test-only bridge from a replayed wire result to the runtime settlement
   *  callback whose absorbing epoch guard the conformance corpus exercises. */
  onReplayedPromptResult?(): void
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
  completeTurn(stopReason?: 'end_turn' | 'cancelled' | 'refusal'): void
  failProviderTurn(detail: string): void
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

  const push = (frame: unknown): void => {
    const line = JSON.stringify(frame)
    if (handler) handler.line(line)
    else buffered.push(line)
  }
  const response = (id: string | number, result: unknown): void =>
    push({ jsonrpc: '2.0', id, result })
  const notifyUpdate = (update: Record<string, unknown>): void => {
    eventSeq += 1
    push({
      jsonrpc: '2.0',
      method: 'session/update',
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
                  error: { code: -32000, message: failNextDetail },
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
          server.completeTurn('cancelled')
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
      notifyUpdate({
        sessionUpdate: 'turn_completed',
        stop_reason: 'error',
        agent_result: detail,
      })
      const result = { stopReason: 'refusal' as const }
      lastPromptResult = { id, result }
      response(id, result)
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
