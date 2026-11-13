export { LlmConfigError } from './llm-error'

/**
 * The wire adapters for Podium's own model calls, with tool calling. One
 * internal message/tool shape; two HTTP adapters, each handed one secret:
 *   - OpenAI-compatible (OpenRouter, OpenAI) — /chat/completions
 *   - Anthropic — /v1/messages
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
