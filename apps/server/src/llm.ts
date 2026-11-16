export { LlmConfigError } from './llm-error'

/**
 * The wire adapters for Podium's own model calls, with tool calling. One
 * internal message/tool shape; three HTTP adapters, each handed one secret:
 *   - OpenAI-compatible (OpenRouter, OpenAI) — /chat/completions
 *   - Anthropic — /v1/messages
 *   - OpenAI Responses on a ChatGPT plan — /v1/responses (credential
 *     management §11), with the access token the keeper hands out
 * Which credential a call runs on, and so which secret an adapter receives, is
 * decided by `modules/inference/complete.ts` through the credential resolver.
 * A ChatGPT login's calls run on the machine that holds it (`codex-machine.ts`).
 * No SDK dependency on purpose: a few fetch shapes are smaller than a framework.
 */

export interface ToolCall {
  id: string
  name: string
  /** JSON-encoded arguments, exactly as the model produced them. */
  arguments: string
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string }

export interface LlmTool {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>
}

export interface LlmResponse {
  text: string
  toolCalls: ToolCall[]
}

/** Tokens a provider reported for one call, when it reports them. */
export interface LlmUsage {
  inputTokens: number
  outputTokens: number
}

export type LlmAnswer = LlmResponse & { usage?: LlmUsage }

export type FetchLike = typeof fetch

/** A provider call that never settles wedges the superagent on "Thinking…" with
 *  no way out — reasoning models are slow, but not minutes-of-silence slow. Abort
 *  past this so the turn always resolves (with a surfaced error) instead of hanging. */
const LLM_TIMEOUT_MS = 120_000

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  ms = LLM_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`request timed out after ${Math.round(ms / 1000)}s — ${url}`)
    }
    throw err
  }
}

/** Where the OpenAI-compatible chat route sends a call. */
export const OPENAI_BASE = 'https://api.openai.com/v1'
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

// ---- OpenAI-compatible (OpenRouter, OpenAI) ----

export async function openaiChat(
  fetchImpl: FetchLike,
  base: string,
  key: string,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
): Promise<LlmAnswer> {
  const body = {
    model,
    messages: messages.map((m) => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        }
      }
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId }
      }
      return { role: m.role, content: m.content }
    }),
    ...(tools.length > 0
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
  }
  const res = await fetchWithTimeout(fetchImpl, `${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${base} ${res.status}: ${truncate(await res.text(), 400)}`)
  }
  const data = (await res.json()) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    choices?: {
      message?: {
        content?: string | null
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
      }
    }[]
  }
  const msg = data.choices?.[0]?.message
  return {
    ...(data.usage
      ? {
          usage: {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
          },
        }
      : {}),
    text: msg?.content ?? '',
    toolCalls: (msg?.tool_calls ?? []).flatMap((c) =>
      c.function?.name
        ? [
            {
              id: c.id ?? `call_${Math.random().toString(36).slice(2)}`,
              name: c.function.name,
              arguments: c.function.arguments ?? '{}',
            },
          ]
        : [],
    ),
  }
}

// ---- Anthropic ----

export async function anthropicMessages(
  fetchImpl: FetchLike,
  key: string,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
): Promise<LlmAnswer> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  type Block = Record<string, unknown>
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = out.at(-1)
    // Anthropic requires strict user/assistant alternation; merge same-role runs
    // (e.g. several tool_result blocks) into one message.
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') push('user', [{ type: 'text', text: m.content }])
    else if (m.role === 'assistant') {
      const blocks: Block[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: parseJson(c.arguments) })
      }
      if (blocks.length > 0) push('assistant', blocks)
    } else {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }])
    }
  }
  const res = await fetchWithTimeout(fetchImpl, ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      ...(system ? { system } : {}),
      messages: out,
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${truncate(await res.text(), 400)}`)
  }
  const data = (await res.json()) as {
    usage?: { input_tokens?: number; output_tokens?: number }
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]
  }
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  const toolCalls = (data.content ?? [])
    .filter((b) => b.type === 'tool_use' && b.name)
    .map((b) => ({
      id: b.id ?? `toolu_${Math.random().toString(36).slice(2)}`,
      name: b.name as string,
      arguments: JSON.stringify(b.input ?? {}),
    }))
  return {
    ...(data.usage
      ? {
          usage: {
            inputTokens: data.usage.input_tokens ?? 0,
            outputTokens: data.usage.output_tokens ?? 0,
          },
        }
      : {}),
    text,
    toolCalls,
  }
}

// ---- OpenAI Responses, on a ChatGPT plan (credential management §11) ----

export const OPENAI_RESPONSES_URL = `${OPENAI_BASE}/responses`
export const OPENAI_MODELS_URL = `${OPENAI_BASE}/models`
/** OpenAI's answer when the person's plan limit (or this app's) is reached. */
export const CHATGPT_PLAN_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded'

/**
 * One Responses call on a ChatGPT plan token. What the plan route requires
 * (POD-6894): `store: false`, `stream: true`, the whole conversation in
 * `input`, system text in `instructions` (a system item is refused), and none
 * of the unsupported fields (`max_output_tokens`, `temperature`, `top_p`,
 * `metadata`, `user`, `previous_response_id`, …). The answer is read as a
 * server-sent event stream because the request asked for one: it carries no
 * `text/event-stream` content type. Only `response.completed` is success.
 *
 * Errors read `openai-responses <status>: <code or detail>`. A plan limit that
 * arrives mid-stream as `response.failed` is reported as status 429, the same
 * as when it arrives before the stream.
 */
export async function openaiResponses(
  fetchImpl: FetchLike,
  token: string,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
): Promise<LlmAnswer> {
  const instructions = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const input: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') input.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const c of m.toolCalls ?? []) {
        input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })
      }
    } else {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
    }
  }
  const res = await fetchWithTimeout(fetchImpl, OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
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
          }
        : {}),
      store: false,
      stream: true,
    }),
  })
  if (!res.ok) {
    throw new Error(`openai-responses ${res.status}: ${responsesErrorText(await res.text())}`)
  }
  return await readResponsesStream(res)
}

/** `{"detail": …}` (admission) or `{"error": {"code", "message"}}`, whatever the content type. */
function responsesErrorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: unknown
      error?: { code?: unknown; message?: unknown }
    }
    if (typeof parsed.detail === 'string') return truncate(parsed.detail, 300)
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : undefined
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : undefined
    if (code || message) return truncate([code, message].filter(Boolean).join(': '), 300)
  } catch {
    // Not JSON: the text itself.
  }
  return truncate(body, 300)
}

interface ResponsesItem {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: { type?: string; text?: string }[]
}

async function readResponsesStream(res: Response): Promise<LlmAnswer> {
  if (!res.body) throw new Error('openai-responses: the answer has no body')
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffer = ''
  let deltas = ''
  const doneItems: ResponsesItem[] = []
  let completed: { output?: ResponsesItem[]; usage?: Record<string, unknown> } | undefined
  const onEvent = (data: string) => {
    if (data === '[DONE]') return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    const type = event.type
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      deltas += event.delta
    } else if (type === 'response.output_item.done' && event.item) {
      doneItems.push(event.item as ResponsesItem)
    } else if (type === 'response.completed') {
      completed = (event.response ?? {}) as typeof completed
    } else if (type === 'response.failed' || type === 'error') {
      const response = event.response as
        | { error?: { code?: unknown; message?: unknown } }
        | undefined
      const error = (response?.error ?? event.error ?? event) as {
        code?: unknown
        message?: unknown
      }
      const code = typeof error.code === 'string' ? error.code : undefined
      const message = typeof error.message === 'string' ? error.message : undefined
      if (code === CHATGPT_PLAN_LIMIT_CODE) {
        throw new Error(`openai-responses 429: ${code}`)
      }
      throw new Error(
        `openai-responses failed: ${truncate([code, message].filter(Boolean).join(': ') || 'no reason given', 300)}`,
      )
    } else if (type === 'response.incomplete') {
      throw new Error('openai-responses: the answer stopped before it was complete')
    }
  }
  const drain = (final: boolean) => {
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = final ? '' : (blocks.pop() ?? '')
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) onEvent(data)
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      drain(false)
      if (completed) break
    }
    buffer += decoder.decode()
    if (!completed) drain(true)
  } finally {
    reader.releaseLock()
  }
  if (!completed) throw new Error('openai-responses: the stream ended without response.completed')
  const items = completed.output && completed.output.length > 0 ? completed.output : doneItems
  const text =
    items
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('') || deltas
  const toolCalls = items
    .filter((item) => item.type === 'function_call' && item.name)
    .map((item) => ({
      id: item.call_id ?? `call_${Math.random().toString(36).slice(2)}`,
      name: item.name as string,
      arguments: item.arguments ?? '{}',
    }))
  const usage = completed.usage
  return {
    ...(usage && typeof usage.input_tokens === 'number'
      ? {
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
          },
        }
      : {}),
    text,
    toolCalls,
  }
}

/** The models a ChatGPT plan offers for display, in OpenAI's order (`visibility: "list"`). */
export async function listChatgptModels(
  fetchImpl: FetchLike,
  token: string,
): Promise<{ slug: string; displayName: string }[]> {
  const res = await fetchWithTimeout(
    fetchImpl,
    OPENAI_MODELS_URL,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    30_000,
  )
  if (!res.ok) {
    throw new Error(`openai-responses ${res.status}: ${responsesErrorText(await res.text())}`)
  }
  const body = (await res.json()) as {
    models?: { slug?: unknown; display_name?: unknown; visibility?: unknown }[]
  }
  return (body.models ?? []).flatMap((m) =>
    m.visibility === 'list' && typeof m.slug === 'string'
      ? [
          {
            slug: m.slug,
            displayName: typeof m.display_name === 'string' ? m.display_name : m.slug,
          },
        ]
      : [],
  )
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
