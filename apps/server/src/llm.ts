import type { LlmBackend, PodiumSettings } from '@podium/runtime'
import { LlmConfigError } from './llm-error'
export { LlmConfigError } from './llm-error'

/**
 * Minimal multi-provider chat-completion client with tool calling. One internal
 * message/tool shape; three wire adapters:
 *   - OpenAI-compatible (OpenRouter, OpenAI) — /chat/completions
 *   - Anthropic — /v1/messages
 *   - Codex (ChatGPT subscription) — the Responses API, run on the machine
 *     that owns the catalog login (see `codexTransport` below, POD-4750)
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
  /**
   * The material for THIS backend's provider, resolved by the caller — POD-419.
   *
   * It used to be `PodiumSettings['apiKeys']`, the whole three-key object out of
   * the settings blob. The secrets now live in the server-only keyed store, and
   * passing one resolved key rather than a record of them is deliberate: a
   * function that takes every key can be handed the blob again, and the blob is
   * what round-trips to a browser. `undefined` is "not configured" and lands on
   * the `LlmConfigError` below.
   */
  apiKey: string | undefined,
  fetchImpl: FetchLike = fetch,
  /**
   * How a `codex` turn runs (POD-4750). The server holds no Codex login file,
   * so the turn is performed by the daemon on the machine the login catalog
   * names — the composition root builds this over the daemon RPC + the scoped
   * machine picker (`codex-machine.ts`). Absent = fail closed: a codex backend
   * with no transport is "not configured", never a local file read.
   */
  opts: { codexTransport?: CodexTransport } = {},
): LlmClient {
  if (backend.kind !== 'api') {
    throw new LlmConfigError(
      'harness-backed execution is chat-only and runs via the daemon — no tool client here',
    )
  }
  if (backend.provider === 'codex') return codexClient(backend, opts.codexTransport)
  const key = apiKey
  if (!key) {
    throw new LlmConfigError(
      `no API key configured for ${backend.provider} — add one in Settings → API keys`,
    )
  }
  const label = `${backend.provider} · ${backend.model}`
  if (backend.provider === 'anthropic') {
    return { label, complete: async (m, t) => await anthropicComplete(fetchImpl, key, backend.model, m, t) }
  }
  const base =
    backend.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'
  return {
    label,
    complete: async (m, t) => await openaiComplete(fetchImpl, base, key, backend.model, m, t),
  }
}

/** Codex reasoning effort: honor the backend's configured effort (SP-6454 B3),
 *  falling back to 'medium'. The Responses API takes low|medium|high. */
function codexEffort(backend: LlmBackend): 'low' | 'medium' | 'high' {
  const e = backend.harnessEffort
  return e === 'low' || e === 'high' ? e : 'medium'
}

/**
 * One Codex turn on the catalog login's owning machine (POD-4750). Built by
 * the composition root over the daemon RPC + the scoped machine picker: it
 * picks the machine, sends the turn, and returns ONLY the model's reply. The
 * token never leaves that machine and never crosses this interface.
 *
 * `harness` is the backend's resolved harness — a value that flowed from the
 * role's account, selecting which login to spend. In production a `codex`
 * provider always resolves to the codex harness (the roles read path pairs
 * them); the picker matches on the value, never a literal.
 */
export interface CodexTransport {
  complete(
    model: string,
    messages: LlmMessage[],
    tools: LlmTool[],
    effort: 'low' | 'medium' | 'high',
    harness: LlmBackend['harnessAgent'],
  ): Promise<LlmResponse>
}

/** The `codex` provider needs no API key — it runs on the owning daemon's ChatGPT login. */
function codexClient(backend: LlmBackend, transport: CodexTransport | undefined): LlmClient {
  if (!transport) {
    throw new LlmConfigError(
      'Codex server AI needs a machine transport — no connected Codex login is available.',
    )
  }
  const model = backend.model && backend.model !== 'auto' ? backend.model : 'gpt-5.5'
  const effort = codexEffort(backend)
  const harness = backend.harnessAgent
  return {
    label: `codex · ${model} (ChatGPT subscription)`,
    complete: async (m, t) => await transport.complete(model, m, t, effort, harness),
  }
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
