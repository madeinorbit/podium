/**
 * Codex Responses API wire — the Inventory credentials section's pure HTTP
 * knowledge (POD-4750).
 *
 * KNOWLEDGE, not mechanism: how our chat-shaped history maps onto the
 * Responses API's typed `input` items, which headers the backend requires, and
 * how the streamed SSE reply folds back into text + tool calls. Moved verbatim
 * from `apps/server/src/llm.ts` (`toResponsesInput`, the request body,
 * `parseResponsesSse`) so that only WHERE the HTTPS call runs moves — the
 * daemon imports this, the server no longer calls the backend directly.
 *
 * Pure data transformation: no fetch, no filesystem, no clock. The fetch (with
 * its timeout) and the auth-file reads live in the daemon's control handler,
 * which is the only side that may hold the token.
 */

/** One tool call the model produced, exactly as it will ride the wire. */
export interface CodexToolCall {
  id: string
  name: string
  /** JSON-encoded arguments, exactly as the model produced them. */
  arguments: string
}

export type CodexLlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: CodexToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string }

export interface CodexLlmTool {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>
}

export interface CodexLlmResponse {
  text: string
  toolCalls: CodexToolCall[]
}

export type CodexEffort = 'low' | 'medium' | 'high'

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** Carries the HTTP status so the caller can re-read auth once on a 401. */
export class CodexHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Map our chat-shaped history onto the Responses API's typed `input` items. */
export function toCodexResponsesInput(messages: CodexLlmMessage[]): {
  instructions: string
  input: object[]
} {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const input: object[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: m.content }],
      })
    } else if (m.role === 'assistant') {
      if (m.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        })
      }
      for (const c of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })
      }
    } else {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
    }
  }
  return { instructions, input }
}

/** Build the exact JSON body the Responses API receives. */
export function buildCodexResponsesBody(
  model: string,
  messages: CodexLlmMessage[],
  tools: CodexLlmTool[],
  effort: CodexEffort = 'medium',
): Record<string, unknown> {
  const { instructions, input } = toCodexResponsesInput(messages)
  return {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    ...(tools.length > 0
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
          tool_choice: 'auto',
          parallel_tool_calls: true,
        }
      : {}),
    reasoning: { effort },
    stream: true,
    store: false,
  }
}

/** The headers the backend requires for a ChatGPT-subscription call. */
export function codexResponsesHeaders(auth: {
  accessToken: string
  accountId: string
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${auth.accessToken}`,
    'chatgpt-account-id': auth.accountId,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    session_id: randomCodexId(),
  }
}

/**
 * The backend streams Server-Sent Events. Tokens are not surfaced
 * incrementally (the caller renders a whole turn), so fold the full stream and
 * pull the final, completed items: `message` items carry the text,
 * `function_call` items carry tool calls. Reasoning and partial-delta events
 * are ignored.
 */
export function parseCodexResponsesSse(raw: string): CodexLlmResponse {
  let text = ''
  const toolCalls: CodexToolCall[] = []
  let failure: string | undefined
  for (const line of raw.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let evt: {
      type?: string
      item?: {
        type?: string
        content?: { type?: string; text?: string }[]
        call_id?: string
        name?: string
        arguments?: string
      }
      response?: { status?: string; error?: { message?: string } }
    }
    try {
      evt = JSON.parse(payload)
    } catch {
      continue
    }
    if (evt.type === 'response.output_item.done' && evt.item) {
      const item = evt.item
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && part.text) text += part.text
        }
      } else if (item.type === 'function_call' && item.name) {
        toolCalls.push({
          id: item.call_id ?? randomCodexId(),
          name: item.name,
          arguments: item.arguments ?? '{}',
        })
      }
    } else if (evt.type === 'response.failed' || evt.type === 'error') {
      failure = evt.response?.error?.message ?? 'codex stream failed'
    }
  }
  if (failure && !text && toolCalls.length === 0) throw new Error(failure)
  return { text, toolCalls }
}

export function randomCodexId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function truncateCodexError(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
