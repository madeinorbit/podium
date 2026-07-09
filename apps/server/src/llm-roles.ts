// The one-shot (non-harness) LLM primitive for background features (issue
// assistant, title generation, summaries). Features build on completeForRole
// instead of reaching for llmClient directly, so role → backend → account
// resolution lives in one place (SP-6454, stream B1).
//
// Interactive-session roles (coding sessions, superagent turns) run through the
// daemon harness path, not here.
import { type PodiumSettings, roleApiBackend } from '@podium/core'
import type { z } from 'zod'
import { type LlmClient, type LlmMessage, llmClient } from './llm'

/** Roles that make a one-shot completion. */
export type OneShotRole = 'background' | 'superagent'

/** Resolve a role's one-shot (api) backend from the unified role model. A role
 *  whose account is a harness yields kind:'harness', which llmClient rejects
 *  (harness-print one-shot is still "coming soon"). */
export function resolveOneShotBackend(settings: PodiumSettings, role: OneShotRole) {
  return roleApiBackend(settings, role)
}

export interface CompleteForRoleDeps {
  settings: PodiumSettings
  /** Injectable client factory (tests / alternate transports). */
  llm?: typeof llmClient
}

interface BaseOpts {
  role: OneShotRole
  messages: LlmMessage[]
  /** Accepted for forward-compat; the api path wires effort in B3
   *  (RoleBackend.effort). Ignored today. */
  effort?: string
}

/**
 * Resolve a role's backend + account, run a single completion, and optionally
 * parse the response into structured data. With `parse`, `data` is the parsed
 * value (or null when the model's output can't be parsed); without it, `data`
 * is the raw text. Throws on config/network errors — callers decide whether to
 * treat a failure as a no-op (as the issue assistant does).
 */
export async function completeForRole(
  deps: CompleteForRoleDeps,
  opts: BaseOpts,
): Promise<{ text: string; data: string; label: string }>
export async function completeForRole<T>(
  deps: CompleteForRoleDeps,
  opts: BaseOpts & { parse: (text: string) => T | null },
): Promise<{ text: string; data: T | null; label: string }>
export async function completeForRole<T>(
  deps: CompleteForRoleDeps,
  opts: BaseOpts & { parse?: (text: string) => T | null },
): Promise<{ text: string; data: T | null | string; label: string }> {
  const backend = resolveOneShotBackend(deps.settings, opts.role)
  const factory = deps.llm ?? llmClient
  const client: LlmClient = factory(backend, deps.settings.apiKeys)
  const resp = await client.complete(opts.messages, [])
  const data = opts.parse ? opts.parse(resp.text) : resp.text
  return { text: resp.text, data, label: client.label }
}

/**
 * Adapt a zod schema into a lenient `parse` function: pull the first fenced or
 * braced JSON object out of the model's text and validate it. New structured
 * features (title generation) pass `jsonSchema(MySchema)` as `parse`.
 */
export function jsonSchema<T>(schema: z.ZodType<T>): (text: string) => T | null {
  return (text: string) => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const raw = (fenced?.[1] ?? text).trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end < start) return null
    try {
      const result = schema.safeParse(JSON.parse(raw.slice(start, end + 1)))
      return result.success ? result.data : null
    } catch {
      return null
    }
  }
}
