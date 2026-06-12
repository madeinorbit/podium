import type { LlmBackend, PodiumSettings } from '@podium/core'

/**
 * Minimal multi-provider chat-completion client with tool calling. One internal
 * message/tool shape; two wire adapters:
 *   - OpenAI-compatible (OpenRouter, OpenAI) — /chat/completions
 *   - Anthropic — /v1/messages
 * No SDK dependency on purpose: two fetch shapes are smaller than a framework,
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
  const res = await fetchImpl(`${base}/chat/completions`, {
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
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
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
