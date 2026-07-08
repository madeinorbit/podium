import type { LlmBackend, PodiumSettings } from '@podium/core'
import { type CodexAuth, codexLoginPresent, resolveCodexAuth } from './codex-auth'

/**
 * Minimal multi-provider chat-completion client with tool calling. One internal
 * message/tool shape; three wire adapters:
 *   - OpenAI-compatible (OpenRouter, OpenAI) — /chat/completions
 *   - Anthropic — /v1/messages
 *   - Codex (ChatGPT subscription) — the Responses API, auth'd off the local
 *     `codex login` instead of an API key (see ./codex-auth)
 * No SDK dependency on purpose: a few fetch shapes are smaller than a framework,
 * and the superagent loop needs nothing fancier.
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

export class LlmConfigError extends Error {}

export interface LlmClient {
  complete(messages: LlmMessage[], tools: LlmTool[]): Promise<LlmResponse>
  /** Human description for the UI ("openrouter · anthropic/claude-sonnet-4.5"). */
  readonly label: string
}

type FetchLike = typeof fetch

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

/** Build a client for an api-kind backend. Throws LlmConfigError when unusable. */
export function llmClient(
  backend: LlmBackend,
  apiKeys: PodiumSettings['apiKeys'],
  fetchImpl: FetchLike = fetch,
): LlmClient {
  if (backend.kind !== 'api') {
    throw new LlmConfigError(
      'harness-backed execution is chat-only and runs via the daemon — no tool client here',
    )
  }
  if (backend.provider === 'codex') return codexClient(backend, fetchImpl)
  const key = apiKeys[backend.provider]
  if (!key) {
    throw new LlmConfigError(
      `no API key configured for ${backend.provider} — add one in Settings → API keys`,
    )
  }
  const label = `${backend.provider} · ${backend.model}`
  if (backend.provider === 'anthropic') {
    return { label, complete: (m, t) => anthropicComplete(fetchImpl, key, backend.model, m, t) }
  }
  const base =
    backend.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'
  return {
    label,
    complete: (m, t) => openaiComplete(fetchImpl, base, key, backend.model, m, t),
  }
}

/** Codex reasoning effort: honor the backend's configured effort (SP-6454 B3),
 *  falling back to 'medium'. The Responses API takes low|medium|high. */
function codexEffort(backend: LlmBackend): 'low' | 'medium' | 'high' {
  const e = backend.harnessEffort
  return e === 'low' || e === 'high' ? e : 'medium'
}

/** The `codex` provider needs no API key — it reuses the local ChatGPT login. */
function codexClient(backend: LlmBackend, fetchImpl: FetchLike): LlmClient {
  if (!codexLoginPresent()) {
    throw new LlmConfigError("Codex isn't logged in on this server — run `codex login`.")
  }
  const model = backend.model && backend.model !== 'auto' ? backend.model : 'gpt-5.5'
  const effort = codexEffort(backend)
  return {
    label: `codex · ${model} (ChatGPT subscription)`,
    complete: (m, t) => codexCompleteWithAuth(fetchImpl, model, m, t, effort),
  }
}

// ---- Codex backend (ChatGPT subscription, Responses API) ----

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** Carries the HTTP status so the caller can refresh-and-retry on a 401. */
export class CodexHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Resolve the token and call the backend; on a 401, re-read auth once in case a
 * concurrent codex session rotated the token (we never rotate it ourselves). */
async function codexCompleteWithAuth(
  fetchImpl: FetchLike,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
  effort: 'low' | 'medium' | 'high' = 'medium',
): Promise<LlmResponse> {
  let auth = await resolveCodexAuth(fetchImpl)
  try {
    return await codexComplete(fetchImpl, auth, model, messages, tools, effort)
  } catch (err) {
    if (err instanceof CodexHttpError && err.status === 401) {
      auth = await resolveCodexAuth(fetchImpl, { rejectedAccessToken: auth.accessToken })
      return await codexComplete(fetchImpl, auth, model, messages, tools, effort)
    }
    throw err
  }
}

/** Map our chat-shaped history onto the Responses API's typed `input` items. */
function toResponsesInput(messages: LlmMessage[]): { instructions: string; input: object[] } {
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

export async function codexComplete(
  fetchImpl: FetchLike,
  auth: CodexAuth,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
  effort: 'low' | 'medium' | 'high' = 'medium',
): Promise<LlmResponse> {
  const { instructions, input } = toResponsesInput(messages)
  const body = {
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
  const res = await fetchWithTimeout(fetchImpl, CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${auth.accessToken}`,
      'chatgpt-account-id': auth.accountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: randomId(),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new CodexHttpError(res.status, `codex ${res.status}: ${truncate(await res.text(), 400)}`)
  }
  return parseResponsesSse(await res.text())
}

/**
 * The backend streams Server-Sent Events. We don't surface tokens incrementally
 * (the superagent renders a whole turn), so read the full stream and pull the
 * final, completed items: `message` items carry the text, `function_call` items
 * carry tool calls. Reasoning and partial-delta events are ignored.
 */
function parseResponsesSse(raw: string): LlmResponse {
  let text = ''
  const toolCalls: ToolCall[] = []
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
          id: item.call_id ?? randomId(),
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

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

// ---- OpenAI-compatible (OpenRouter, OpenAI) ----

async function openaiComplete(
  fetchImpl: FetchLike,
  base: string,
  key: string,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
): Promise<LlmResponse> {
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
    choices?: {
      message?: {
        content?: string | null
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
      }
    }[]
  }
  const msg = data.choices?.[0]?.message
  return {
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

async function anthropicComplete(
  fetchImpl: FetchLike,
  key: string,
  model: string,
  messages: LlmMessage[],
  tools: LlmTool[],
): Promise<LlmResponse> {
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
  const res = await fetchWithTimeout(fetchImpl, 'https://api.anthropic.com/v1/messages', {
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
  return { text, toolCalls }
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
