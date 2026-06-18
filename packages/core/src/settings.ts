import { z } from 'zod'

/**
 * User-level Podium settings. Stored as one JSON row in the server's SQLite and
 * round-tripped whole over tRPC. Every field has a default so a settings blob
 * written by an older build parses forward — `normalizeSettings` never throws on
 * missing keys, only on type-invalid ones.
 *
 * "auto" for any agent/model choice means *leave it to the agent/harness* — the
 * spawn layer passes no flag and the CLI uses whatever the user configured there.
 */

export const HarnessAgent = z.enum(['claude-code', 'codex', 'grok', 'opencode'])
export type HarnessAgent = z.infer<typeof HarnessAgent>

export const AgentChoice = z.enum(['auto', 'claude-code', 'codex', 'grok', 'opencode'])
export type AgentChoice = z.infer<typeof AgentChoice>

export const SessionDefaults = z.object({
  /** Which harness a generic "new agent" action starts. */
  agent: AgentChoice.default('auto'),
  /** Model flag for new sessions ('auto' = no flag). */
  model: z.string().default('auto'),
  /** Model for subagents spawned inside a session ('auto' = no override). */
  subagentModel: z.string().default('auto'),
})
export type SessionDefaults = z.infer<typeof SessionDefaults>

export const ApiProvider = z.enum(['openrouter', 'anthropic', 'openai', 'codex'])
export type ApiProvider = z.infer<typeof ApiProvider>

/**
 * How an LLM-powered Podium feature (superagent, background work-LLM) runs.
 * Flat rather than a discriminated union so the settings form can hold both
 * halves' values while the user toggles `kind`.
 *
 * - `harness`: drive a coding-agent CLI. Claude Code's `claude -p` bills
 *   pay-per-use API rates even with a subscription; Grok runs through `grok -p`.
 * - `api`: call a provider over HTTP. OpenRouter/Anthropic/OpenAI use an API key;
 *   `codex` instead reuses the local ChatGPT login (`~/.codex/auth.json`, no key),
 *   talking to the Codex backend's Responses API — effectively free within plan
 *   limits, and unlike the old `codex exec` harness it gets the full tool belt.
 */
export const LlmBackend = z.object({
  kind: z.enum(['harness', 'api']).default('api'),
  harnessAgent: HarnessAgent.default('claude-code'),
  harnessModel: z.string().default('auto'),
  provider: ApiProvider.default('openrouter'),
  model: z.string().default('anthropic/claude-sonnet-4.5'),
})
export type LlmBackend = z.infer<typeof LlmBackend>

export const PodiumSettings = z.object({
  sessionDefaults: SessionDefaults.default({}),
  superagent: LlmBackend.default({}),
  workLlm: LlmBackend.default({ model: 'google/gemini-2.5-flash' }),
  /** Provider API keys. Stored plaintext in the self-hosted SQLite — same trust
   *  domain as the shell the agents already run in. */
  apiKeys: z
    .object({
      openrouter: z.string().default(''),
      anthropic: z.string().default(''),
      openai: z.string().default(''),
    })
    .default({}),
  integrations: z
    .object({
      linearApiKey: z.string().default(''),
    })
    .default({}),
  hibernation: z
    .object({
      enabled: z.boolean().default(true),
      /** Hibernate idle sessions once host memory use crosses this percentage. */
      memoryPct: z.number().int().min(50).max(95).default(80),
      /** A session counts as idle after this many minutes without activity. */
      idleMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60)
        .default(30),
    })
    .default({}),
  notifications: z
    .object({
      web: z.boolean().default(true),
      /** ntfy.sh topic for mobile push (empty = off). */
      ntfyTopic: z.string().default(''),
    })
    .default({}),
})
export type PodiumSettings = z.infer<typeof PodiumSettings>

export const DEFAULT_SETTINGS: PodiumSettings = PodiumSettings.parse({})

/**
 * The Codex "harness" backend shelled out to `codex exec` — heavyweight, prone to
 * hanging, and chat-only. Codex now runs as an API provider against the ChatGPT
 * Responses backend (full tools, no CLI, no hang), so fold any saved Codex-harness
 * config onto that path. Claude Code and Grok harnesses are untouched.
 */
function migrateCodexHarness(b: LlmBackend): LlmBackend {
  if (b.kind !== 'harness' || b.harnessAgent !== 'codex') return b
  return {
    ...b,
    kind: 'api',
    provider: 'codex',
    model: b.harnessModel && b.harnessModel !== 'auto' ? b.harnessModel : 'gpt-5.5',
  }
}

/** Parse a stored/transmitted blob, filling anything missing with defaults. */
export function normalizeSettings(raw: unknown): PodiumSettings {
  const parsed = PodiumSettings.parse(raw ?? {})
  return {
    ...parsed,
    superagent: migrateCodexHarness(parsed.superagent),
    workLlm: migrateCodexHarness(parsed.workLlm),
  }
}
