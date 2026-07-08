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

/** Auto-continue backoff: first cooldown after a `continue` nudge, doubling each
 *  consecutive retry, capped. `min(BASE * 2^attempt, MAX)`. */
export const AUTO_CONTINUE_BASE_DELAY_MS = 10_000
export const AUTO_CONTINUE_MAX_DELAY_MS = 300_000

export const HarnessAgent = z.enum(['claude-code', 'codex', 'grok', 'opencode', 'cursor'])
export type HarnessAgent = z.infer<typeof HarnessAgent>

/**
 * The one capability matrix (issue #84): which harness CLIs can mount Podium's
 * HTTP MCP server (orchestrator tools + per-thread identity headers, issue #67)
 * on a one-shot headless invocation. Superagent turns route through the full
 * harness when support is 'full'; anything else runs the api tool-loop fallback
 * with a visible notice — never a silent, tool-less harness.
 *
 * - claude-code: `--mcp-config <file>` + `--allowedTools` (long-standing).
 * - codex: `codex exec -c mcp_servers.<name>.url=… -c mcp_servers.<name>.http_headers={…}`
 *   — verified against codex-cli 0.142.5: custom headers arrive on every MCP
 *   request (streamable HTTP client), turn completes.
 * - grok / opencode / cursor: no per-invocation MCP mounting today.
 */
export const HARNESS_MCP_SUPPORT: Record<HarnessAgent, 'full' | 'none'> = {
  'claude-code': 'full',
  codex: 'full',
  grok: 'none',
  opencode: 'none',
  cursor: 'none',
}

export const AgentChoice = z.enum(['auto', 'claude-code', 'codex', 'grok', 'opencode', 'cursor'])
export type AgentChoice = z.infer<typeof AgentChoice>

export const SessionDefaults = z.object({
  /** Which harness a generic "new agent" action starts. */
  agent: AgentChoice.default('auto'),
  /** Model flag for new sessions ('auto' = no flag). */
  model: z.string().default('auto'),
  /** Model for subagents spawned inside a session ('auto' = no override). */
  subagentModel: z.string().default('auto'),
  /** Reasoning effort flag for new sessions ('auto' = no flag). Mapped to each
   *  agent CLI's effort flag at spawn (claude/grok `--effort`, codex reasoning
   *  config, opencode `--variant`); ignored for agents without one (cursor). */
  effort: z.string().default('auto'),
  /** Which panel screen a new session opens on.
   *  - 'native': always start on the terminal (default)
   *  - 'chat': always start on the chat view (when capable)
   *  - 'auto': device heuristic (chat on mobile, native on desktop) */
  startScreen: z.enum(['native', 'chat', 'auto']).default('native'),
})
export type SessionDefaults = z.infer<typeof SessionDefaults>

export const ApiProvider = z.enum(['openrouter', 'anthropic', 'openai', 'codex'])
export type ApiProvider = z.infer<typeof ApiProvider>

/**
 * How an LLM-powered Podium feature (superagent, background work-LLM) runs.
 * Flat rather than a discriminated union so the settings form can hold both
 * halves' values while the user toggles `kind`.
 *
 * - `harness`: drive a coding-agent CLI with that CLI's local login/provider
 *   account. Usage can count against plan limits or API billing depending on the
 *   selected harness and account configuration.
 * - `api`: call a provider over HTTP. OpenRouter/Anthropic/OpenAI use an API key;
 *   `codex` instead reuses the local ChatGPT login (`~/.codex/auth.json`, no key),
 *   talking to the Codex backend's Responses API — covered by plan limits, and
 *   unlike the old `codex exec` harness it gets the full tool belt.
 */
export const LlmBackend = z.object({
  kind: z.enum(['harness', 'api']).default('api'),
  harnessAgent: HarnessAgent.default('claude-code'),
  harnessModel: z.string().default('auto'),
  /** Reasoning effort for the harness ('auto' = no flag). Mapped to each CLI's
   *  effort flag at spawn, like SessionDefaults.effort. Ignored by the api path
   *  until the one-shot effort primitive lands (stream B). */
  harnessEffort: z.string().default('auto'),
  provider: ApiProvider.default('openrouter'),
  model: z.string().default('anthropic/claude-sonnet-4.5'),
})
export type LlmBackend = z.infer<typeof LlmBackend>

// ── Accounts & roles (SP-6454, LLM & Harness Access) ───────────────────────
// Full domain model, defined now per the staging decision. NATIVE is what the
// runtime wires; MANAGED (credential injection + oauth rotation) ships behind a
// "Coming soon" flag. Not yet folded into PodiumSettings — the one-shot role
// primitive resolves against the existing superagent/workLlm/sessionDefaults
// backends for now; stream B3 migrates settings onto RoleBackend.

/** Who owns the credential: the machine's own CLI login (observe-only) vs a
 *  credential Podium holds and injects. */
export const AccountSource = z.enum(['native', 'managed'])
export type AccountSource = z.infer<typeof AccountSource>

/** Managed-only: how Podium injects the credential it holds (native is opaque). */
export const AccountKind = z.enum(['api-key', 'oauth'])
export type AccountKind = z.infer<typeof AccountKind>

export const AccountProvider = z.enum(['anthropic', 'openai', 'openrouter', 'xai', 'google'])
export type AccountProvider = z.infer<typeof AccountProvider>

/** An auth source. Native = reference to a CLI login on a machine (identity +
 *  quota observed at use-time, never cached). Managed = Podium holds+injects;
 *  `kind` decides how. Enterprise/plan is descriptive `identity`, not a kind. */
export const Account = z.object({
  id: z.string(),
  provider: AccountProvider,
  source: AccountSource,
  // native: which login on which machine.
  machineId: z.string().optional(),
  harness: HarnessAgent.optional(),
  // managed (coming soon): injection mechanism; credential stored separately.
  kind: AccountKind.optional(),
  // observed, freshness-stamped — e.g. "mike@… · Claude Max".
  identity: z.string().optional(),
})
export type Account = z.infer<typeof Account>

/** One role's backend over a single shape (unifies superagent/workLlm/
 *  sessionDefaults in B3). `harness` only for interactive-session roles;
 *  a role binding may later reference a set of accounts for rotation. */
export const RoleBackend = z.object({
  accountId: z.string().optional(),
  model: z.string().default('auto'),
  effort: z.string().default('auto'),
  harness: HarnessAgent.optional(),
})
export type RoleBackend = z.infer<typeof RoleBackend>

export const Sidebar = z.object({
  repoSort: z.enum(['alphabetical', 'lastUsed', 'custom']).default('lastUsed'),
  repoOrder: z.array(z.string()).default([]),
  groupByRepo: z.boolean().default(false),
})
export type Sidebar = z.infer<typeof Sidebar>

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
      /** Telegram bot token for global server push (empty = off). */
      telegramBotToken: z.string().default(''),
      /** Telegram chat id or @channelusername for global server push (empty = off). */
      telegramChatId: z.string().default(''),
    })
    .default({}),
  sidebar: Sidebar.default({}),
  gitWorkflow: z
    .object({
      /** Parent branch for new issue worktrees + merge target. '' = auto-detect repo default. */
      defaultParentBranch: z.string().default(''),
      mergeStyle: z.enum(['ff-only', 'pr', 'ask']).default('ff-only'),
      autoRebaseBeforeMerge: z.boolean().default(true),
    })
    .default({}),
  issues: z
    .object({
      assistantEnabled: z.boolean().default(true),
    })
    .default({}),
  /** The steward: the orchestrator's trigger queue over the durable event log
   *  (deterministic unblock nudges etc.). Ships dark — default off. */
  steward: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
  /** When enabled, the server re-sends `continue` to any session stopped on a
   *  retryable error, on an escalating backoff up to 5 min. `promptDismissed`
   *  suppresses the one-time opt-in popup once the user has answered it. */
  autoContinue: z
    .object({
      enabled: z.boolean().default(false),
      promptDismissed: z.boolean().default(false),
    })
    .default({}),
})
export type PodiumSettings = z.infer<typeof PodiumSettings>

export const DEFAULT_SETTINGS: PodiumSettings = PodiumSettings.parse({})

/**
 * The old Codex "harness" backend shelled out to a bare, tool-less `codex exec`
 * — chat-only and prone to hanging, so it was folded onto the ChatGPT Responses
 * API. That stays true for the workLlm (a pure completion consumer). The
 * SUPERAGENT codex harness is back (issue #84): it now mounts Podium's MCP
 * tools per-invocation (see HARNESS_MCP_SUPPORT), so a saved codex-harness
 * superagent choice is honored, not migrated away.
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
    workLlm: migrateCodexHarness(parsed.workLlm),
  }
}

/**
 * Which harness runs a superagent turn (issue #84 — the backend concept
 * collapses: every turn is a full harness turn when the harness can mount our
 * MCP tools). An explicit `kind: 'harness'` choice names its agent; otherwise
 * (legacy api-kind settings, fresh installs) follow the session default, with
 * 'auto' resolving to claude-code — the reference full-capability harness.
 */
export function superagentHarnessAgent(settings: PodiumSettings): HarnessAgent {
  const b = settings.superagent
  if (b.kind === 'harness') return b.harnessAgent
  const fallback = settings.sessionDefaults.agent
  return fallback === 'auto' ? 'claude-code' : fallback
}

/** The first manual Continue click offers to enable auto-continue — but only once
 *  (until answered), and never when it's already on. */
export function shouldPromptAutoContinue(settings: PodiumSettings): boolean {
  return !settings.autoContinue.enabled && !settings.autoContinue.promptDismissed
}
