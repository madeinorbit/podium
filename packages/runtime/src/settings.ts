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
  /** How a coding session's subagents run (SP-6454).
   *  - 'builtin': the harness's own subagents (Task tool) — best when they share
   *    the harness; the only wired option today.
   *  - 'podium': spawn real Podium sessions (needed to use a different harness or
   *    get cross-harness visibility) — COMING SOON, not yet wired. */
  subagentStrategy: z.enum(['builtin', 'podium']).default('builtin'),
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
  /** This backend's reasoning effort ('auto' = provider/CLI default). For a
   *  harness it maps to each CLI's effort flag at spawn (like
   *  SessionDefaults.effort); for the api path it maps to the provider's
   *  reasoning effort (codex Responses API) — SP-6454 B3. */
  harnessEffort: z.string().default('auto'),
  provider: ApiProvider.default('openrouter'),
  model: z.string().default('anthropic/claude-sonnet-4.5'),
})
export type LlmBackend = z.infer<typeof LlmBackend>

// ── Accounts & roles (SP-6454, LLM & Harness Access) ───────────────────────
// The unified model: settings store one RoleBackend per role, keyed by account.
// NATIVE accounts (a CLI's own login) are what the runtime wires; MANAGED
// (credential injection + oauth rotation) ships behind a "Coming soon" flag.
// `normalizeSettings` migrates the legacy sessionDefaults/superagent/workLlm
// blobs onto `roles`; `resolveRole` is the single read path every consumer uses.

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

/** One role's backend over a single shape (the unified model — SP-6454 B3).
 *  `accountId` names the auth source (a synthetic derived id today, e.g.
 *  'native:claude-code' or 'managed:anthropic'; '' = the role's default). The
 *  account determines execution (harness vs api) + provider/harness; `model` +
 *  `effort` layer on top. `harness` makes that choice explicit for persisted UI
 *  selections and can later select a harness for a managed credential; native
 *  superagent accounts imply their harness even on older settings blobs. */
export const RoleBackend = z.object({
  accountId: z.string().default(''),
  model: z.string().default('auto'),
  effort: z.string().default('auto'),
  harness: HarnessAgent.optional(),
})
export type RoleBackend = z.infer<typeof RoleBackend>

/** The coding-session role: a backend plus session-only preferences that don't
 *  apply to the one-shot/orchestrator roles. */
export const CodingRole = RoleBackend.extend({
  /** Model for the harness's own subagents ('auto' = no override). */
  subagentModel: z.string().default('auto'),
  /** How subagents run: 'builtin' (harness's own) or 'podium' (coming soon). */
  subagentStrategy: z.enum(['builtin', 'podium']).default('builtin'),
  /** Which panel a new session opens on. */
  startScreen: z.enum(['native', 'chat', 'auto']).default('native'),
})
export type CodingRole = z.infer<typeof CodingRole>

/** Every LLM/agent role, one shape each. `coding` = new interactive sessions,
 *  `superagent` = the orchestrator, `background` = one-shot work (issue
 *  assistant, title generation, summaries). */
export const Roles = z.object({
  coding: CodingRole.default({}),
  superagent: RoleBackend.default({}),
  background: RoleBackend.default({ model: 'google/gemini-2.5-flash' }),
})
export type Roles = z.infer<typeof Roles>
export type RoleName = keyof Roles

const HARNESS_ACCOUNT = 'native:' as const
const MANAGED_ACCOUNT = 'managed:' as const

/** The Claude subscription setup-token's account suffix — an anthropic credential
 *  that is its own account, distinct from an Anthropic API key. */
const MANAGED_CLAUDE_OAUTH = 'claude-oauth' as const

/** Synthetic account id for the Claude subscription (`claude setup-token`). */
export const CLAUDE_OAUTH_ACCOUNT_ID = `${MANAGED_ACCOUNT}${MANAGED_CLAUDE_OAUTH}` as const

/** Synthetic account id for a native harness login. */
export function nativeAccountId(harness: HarnessAgent): string {
  return `${HARNESS_ACCOUNT}${harness}`
}
/** Synthetic account id for a managed API-key provider. */
export function managedAccountId(provider: ApiProvider): string {
  return `${MANAGED_ACCOUNT}${provider}`
}

/** A credential Podium holds and injects (SP-6454, managed accounts). Only
 *  long-lived, non-CLI-refreshed credentials ride here: a provider API key, or a
 *  Claude `setup-token` OAuth token. The refreshing OAuth blobs (claudeAiOauth,
 *  codex auth.json) are credential FILES, not env, and are out of scope. */
export interface ManagedCredential {
  provider: string
  kind: 'api-key' | 'oauth'
  credential: string
}

/** Which env var a managed credential becomes on an agent spawn. An unmapped
 *  provider or an empty secret yields {} — never a blank env var, which some CLIs
 *  treat as "configured but broken" rather than "absent". */
export function credentialEnv(c: ManagedCredential): Record<string, string> {
  if (!c.credential) return {}
  if (c.kind === 'oauth') {
    // Only Claude has a long-lived, env-consumable OAuth token (`claude setup-token`).
    return c.provider === 'anthropic' ? { CLAUDE_CODE_OAUTH_TOKEN: c.credential } : {}
  }
  const KEY_ENV: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  }
  const name = KEY_ENV[c.provider]
  return name ? { [name]: c.credential } : {}
}

export const Sidebar = z.object({
  repoSort: z.enum(['alphabetical', 'lastUsed', 'custom']).default('lastUsed'),
  repoOrder: z.array(z.string()).default([]),
  groupByRepo: z.boolean().default(false),
})
export type Sidebar = z.infer<typeof Sidebar>

export const PodiumSettings = z.object({
  /** Every LLM/agent role on one unified shape (SP-6454 B3). Migrated from the
   *  legacy sessionDefaults/superagent/workLlm fields by `normalizeSettings`. */
  roles: Roles.default({}),
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

/** Legacy → unified: derive a RoleBackend from an old LlmBackend. A harness
 *  backend → its native account, with `harness` set to force harness execution
 *  (this is how a codex-harness superagent stays a harness, vs a codex-api
 *  backend that runs the Responses API — both share the native codex login).
 *  `collapseCodexHarness` folds a codex *harness* onto the codex api path, which
 *  the workLlm (a chat-only completion consumer) does but the superagent doesn't
 *  (issue #84: codex mounts MCP as a superagent harness). */
function backendToRole(b: LlmBackend, collapseCodexHarness: boolean): Partial<RoleBackend> {
  const mb = collapseCodexHarness ? migrateCodexHarness(b) : b
  if (mb.kind === 'harness') {
    return {
      accountId: nativeAccountId(mb.harnessAgent),
      harness: mb.harnessAgent,
      model: mb.harnessModel,
      effort: mb.harnessEffort,
    }
  }
  const accountId =
    mb.provider === 'codex' ? nativeAccountId('codex') : managedAccountId(mb.provider)
  return { accountId, model: mb.model, effort: mb.harnessEffort }
}

/** One-time migration of the legacy three-config blob (sessionDefaults /
 *  superagent / workLlm) onto `roles`. Returns undefined when there's nothing to
 *  migrate — a fresh blob (defaults apply) or one that already has `roles`. */
function migrateRoles(raw: Record<string, unknown>): Roles | undefined {
  if (raw.roles !== undefined) return undefined
  if (
    raw.sessionDefaults === undefined &&
    raw.superagent === undefined &&
    raw.workLlm === undefined
  ) {
    return undefined
  }
  const sd = SessionDefaults.parse(raw.sessionDefaults ?? {})
  return Roles.parse({
    coding: {
      accountId: nativeAccountId(sd.agent === 'auto' ? 'claude-code' : sd.agent),
      model: sd.model,
      effort: sd.effort,
      subagentModel: sd.subagentModel,
      subagentStrategy: sd.subagentStrategy,
      startScreen: sd.startScreen,
    },
    ...(raw.superagent !== undefined
      ? { superagent: backendToRole(LlmBackend.parse(raw.superagent), false) }
      : {}),
    ...(raw.workLlm !== undefined
      ? { background: backendToRole(LlmBackend.parse(raw.workLlm), true) }
      : {}),
  })
}

/** Parse a stored/transmitted blob, migrating the legacy backend fields onto
 *  `roles` and filling anything missing with defaults. */
export function normalizeSettings(raw: unknown): PodiumSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const roles = migrateRoles(obj)
  return PodiumSettings.parse(roles ? { ...obj, roles } : obj)
}

export interface ResolvedRole {
  accountId: string
  execution: 'harness' | 'api'
  /** The harness to run (session roles) or the fallback harness (api roles). */
  harness: HarnessAgent
  /** Set when execution === 'api'. */
  provider?: ApiProvider
  model: string
  effort: string
}

const DEFAULT_ACCOUNT: Record<RoleName, string> = {
  coding: nativeAccountId('claude-code'),
  // The orchestrator always runs a real harness with Podium's MCP tools. Keep its
  // empty/default account aligned with what the settings UI displays.
  superagent: nativeAccountId('claude-code'),
  background: managedAccountId('openrouter'),
}

/** Decode a synthetic account id into an execution plan for a role. A native
 *  superagent account always means that harness. Background Codex remains the
 *  one special case: that one-shot consumer uses the ChatGPT Responses API. */
function decodeAccount(
  accountId: string,
  role: RoleName,
): { execution: 'harness' | 'api'; harness: HarnessAgent; provider?: ApiProvider } {
  if (accountId.startsWith(HARNESS_ACCOUNT)) {
    const raw = accountId.slice(HARNESS_ACCOUNT.length)
    const harness = HarnessAgent.safeParse(raw).success ? (raw as HarnessAgent) : 'claude-code'
    if (harness === 'codex' && role === 'background') {
      return { execution: 'api', harness, provider: 'codex' }
    }
    return { execution: 'harness', harness }
  }
  if (accountId.startsWith(MANAGED_ACCOUNT)) {
    const raw = accountId.slice(MANAGED_ACCOUNT.length)
    // 'managed:claude-oauth' (the `claude setup-token` subscription credential) is
    // an ANTHROPIC account whose id is not a provider name — without this case it
    // fails the ApiProvider parse and falls back to 'openrouter', quietly turning
    // the Claude subscription into an OpenRouter backend.
    if (raw === MANAGED_CLAUDE_OAUTH) {
      return { execution: 'api', harness: 'claude-code', provider: 'anthropic' }
    }
    const provider = ApiProvider.safeParse(raw).success ? (raw as ApiProvider) : 'openrouter'
    return { execution: 'api', harness: 'claude-code', provider }
  }
  return { execution: 'harness', harness: 'claude-code' }
}

/** The single read path for a role's backend (SP-6454 B3): resolves the role's
 *  account + model + effort into an execution plan every consumer shares. */
export function resolveRole(settings: PodiumSettings, role: RoleName): ResolvedRole {
  const rb = settings.roles[role]
  const accountId = rb.accountId || DEFAULT_ACCOUNT[role]
  // An explicit `harness` forces harness execution — this disambiguates the
  // codex login (CLI harness vs Responses API) and, in future, drives a chosen
  // harness on a managed credential.
  if (rb.harness) {
    return {
      accountId,
      execution: 'harness',
      harness: rb.harness,
      model: rb.model,
      effort: rb.effort,
    }
  }
  return { accountId, ...decodeAccount(accountId, role), model: rb.model, effort: rb.effort }
}

/** Bridge for the llmClient path (one-shot / superagent api loop): reconstruct an
 *  api-shaped LlmBackend from a resolved role. A harness-execution role yields
 *  kind:'harness', which llmClient rejects — harness-print one-shot is still
 *  "coming soon". */
export function roleApiBackend(settings: PodiumSettings, role: RoleName): LlmBackend {
  const r = resolveRole(settings, role)
  return LlmBackend.parse({
    kind: r.execution === 'api' ? 'api' : 'harness',
    harnessAgent: r.harness,
    harnessModel: r.model,
    harnessEffort: r.effort,
    provider: r.provider ?? 'openrouter',
    model: r.model,
  })
}

/**
 * Which harness runs a superagent turn. When the superagent's account resolves
 * to a harness, that's it; a legacy managed-provider setting still falls back
 * to the coding role's harness.
 */
export function superagentHarnessAgent(settings: PodiumSettings): HarnessAgent {
  const sa = resolveRole(settings, 'superagent')
  return sa.execution === 'harness' ? sa.harness : resolveRole(settings, 'coding').harness
}

/** The first manual Continue click offers to enable auto-continue — but only once
 *  (until answered), and never when it's already on. */
export function shouldPromptAutoContinue(settings: PodiumSettings): boolean {
  return !settings.autoContinue.enabled && !settings.autoContinue.promptDismissed
}
