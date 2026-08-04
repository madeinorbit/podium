import {
  type AccountId,
  AccountIdField,
  ApiKeySecrets,
  AutoContinuePreferences,
  asAccountId,
  CodingRole,
  ExperimentalFlags,
  GitWorkflowPolicy,
  HarnessAgent,
  HibernationPolicy,
  IntegrationSecrets,
  IssueAssistantPolicy,
  NotificationRouting,
  NotificationSecrets,
  RoleBackend,
  type RoleName,
  Roles,
  Sidebar,
  StewardPolicy,
} from '@podium/model'
import { z } from 'zod'

/**
 * User-level Podium settings. Stored as one JSON row in the server's SQLite and
 * round-tripped whole over tRPC. Every field has a default so a settings blob
 * written by an older build parses forward — `normalizeSettings` never throws on
 * missing keys, only on type-invalid ones.
 *
 * "auto" for any agent/model choice means *leave it to the agent/harness* — the
 * spawn layer passes no flag and the CLI uses whatever the user configured there.
 *
 * ---------------------------------------------------------------------------
 * THE BLOB IS NOW COMPOSED, NOT DECLARED (POD-418)
 * ---------------------------------------------------------------------------
 *
 * ADR 1's matrix puts this one object on THREE rows — `preferences-personal`
 * (`per-user-state`), `preferences-instance` (`deployment-substrate`) and
 * `server-secrets` (`secret`) — and the split now exists as shapes in
 * `@podium/model` (`settings/preferences.ts`, `settings/secrets.ts`).
 * {@link PodiumSettings} COMPOSES those groups; it does not redeclare them, and
 * this file re-exports the bindings rather than restating them, the way
 * `HarnessAgent` already moved at POD-300.
 *
 * That direction is the point. A parallel set of "split" shapes beside a
 * composite that still owned its own leaves would be two definitions of one
 * vocabulary, and the drift between them would surface only when a scrub
 * migration read the wrong one. `settings.classification.test.ts` reconciles the
 * leaves of this blob against the model's classification IN BOTH DIRECTIONS, so
 * a field added here and to no tier is a test failure rather than an
 * unclassified leaf that the default-closed backstop answers for silently.
 *
 * WHAT IS STILL WRONG HERE, ON PURPOSE: the secret values are still IN the blob
 * and still round-trip to clients. POD-419 owns the client scrub migration and
 * POD-420 the command contracts. What POD-418 landed is the model they both
 * read; nothing about the storage or the wire moved.
 */

/** Auto-continue backoff: first cooldown after a `continue` nudge, doubling each
 *  consecutive retry, capped. `min(BASE * 2^attempt, MAX)`. */
export const AUTO_CONTINUE_BASE_DELAY_MS = 10_000
export const AUTO_CONTINUE_MAX_DELAY_MS = 300_000

/**
 * Re-exported, not redeclared — `@podium/model` owns this vocabulary.
 *
 * `HarnessAgent` moved at POD-300; runtime had kept an identical `z.enum` copy
 * only because the L0 package did not carry it before. POD-418 moved the rest of
 * the settings vocabulary the same way, split by matrix row:
 *
 *   - `preferences-personal`: {@link Roles}, {@link RoleBackend},
 *     {@link CodingRole}, {@link Sidebar}, {@link AutoContinuePreferences},
 *     {@link NotificationRouting}
 *   - `preferences-instance`: {@link HibernationPolicy},
 *     {@link GitWorkflowPolicy}, {@link IssueAssistantPolicy},
 *     {@link StewardPolicy}, {@link ExperimentalFlags}
 *   - `server-secrets`: {@link ApiKeySecrets}, {@link IntegrationSecrets},
 *     {@link NotificationSecrets}
 *
 * Same members, same order, same defaults — the settings wire is unchanged, and
 * `settings.classification.test.ts` asserts each composed member is the model's INSTANCE
 * (`toBe`), because a restatement is byte-identical and only object identity
 * sees the fork (POD-305).
 */
export {
  ApiKeySecrets,
  AutoContinuePreferences,
  CodingRole,
  ExperimentalFlags,
  GitWorkflowPolicy,
  HarnessAgent,
  HibernationPolicy,
  IntegrationSecrets,
  IssueAssistantPolicy,
  NotificationRouting,
  NotificationSecrets,
  RoleBackend,
  type RoleName,
  Roles,
  Sidebar,
  StewardPolicy,
}

/**
 * The stored PREFERENCE for "which harness does a generic new-agent action
 * start" — `'auto'` plus the closed builtin set. A saved setting, not an
 * availability answer.
 *
 * IT MUST NOT GROW AVAILABILITY MEMBERS (POD-303). Adding `'unauthorized'` or
 * `'offline'` here would persist a momentary fact into a config file: whether a
 * harness can be run depends on WHICH MACHINE and WHICH PRINCIPAL, and both
 * change while a stored preference does not. So the two questions stay in two
 * places:
 *   - THIS enum answers "what did the user pick?"
 *   - `agentCapabilityRejection` (@podium/model, predicates/machine-selection)
 *     answers "can it run on that machine, for this principal, right now?" — and
 *     that union is where `'unauthorized'` lives, deliberately DISTINCT from
 *     `'offline'` per docs/multi-user-readiness.md §3.1.4 M5, so spawn UI can
 *     tell "ask the owner for access" from "wake the machine up" instead of
 *     rendering one empty list for both.
 *
 * Consequence for spawn UI: resolve the offer per (choice, machine) through that
 * projection. Reading this enum alone can never express a refusal, so a surface
 * that offers harnesses straight from it will silently offer machines the
 * principal may not use.
 */
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
  id: AccountIdField,
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

const HARNESS_ACCOUNT = 'native:' as const
const MANAGED_ACCOUNT = 'managed:' as const

/** The Claude subscription setup-token's account suffix — an anthropic credential
 *  that is its own account, distinct from an Anthropic API key. */
const MANAGED_CLAUDE_OAUTH = 'claude-oauth' as const

/** Synthetic account id for the Claude subscription (`claude setup-token`). */
export const CLAUDE_OAUTH_ACCOUNT_ID = `${MANAGED_ACCOUNT}${MANAGED_CLAUDE_OAUTH}` as const

/** Synthetic account id for a native harness login. */
export function nativeAccountId(harness: HarnessAgent, fingerprint?: string): AccountId {
  // MINT SITE for a synthetic native AccountId (POD-362).
  return asAccountId(`${HARNESS_ACCOUNT}${harness}${fingerprint ? ':' + fingerprint : ''}`)
}
/** Synthetic account id for a managed API-key provider. */
export function managedAccountId(provider: ApiProvider): AccountId {
  // MINT SITE for a synthetic managed AccountId (POD-362).
  return asAccountId(`${MANAGED_ACCOUNT}${provider}`)
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

/**
 * The legacy `notifications` object: ROUTING (per-user preference) and the bot
 * TOKEN (server-owned secret) in one nested shape, on two matrix rows.
 *
 * Assembled member-by-member from the two model groups rather than by
 * `.extend()`, so the historical key ORDER survives the split — `telegramChatId`
 * has always followed `telegramBotToken` in a serialized blob, and a reordering
 * would be an invisible change to every persisted settings row's JSON. Each
 * member is the model's field INSTANCE; nothing here is a second declaration.
 *
 * POD-419 removes the secret half from what a client holds. Until then the seam
 * is drawn in the model and honoured here.
 */
const NotificationSettings = z.object({
  web: NotificationRouting.shape.web,
  ntfyTopic: NotificationRouting.shape.ntfyTopic,
  telegramBotToken: NotificationSecrets.shape.telegramBotToken,
  telegramChatId: NotificationRouting.shape.telegramChatId,
})

/**
 * The blob, COMPOSED from the three classified halves (POD-418). Key order is
 * the historical one; every value is the model's schema instance.
 *
 * Reading the tiers off this object: `roles` / `sidebar` / `autoContinue` and
 * three of four `notifications` members are `preferences-personal`;
 * `hibernation` / `gitWorkflow` / `issues` / `steward` / `experimental` are
 * `preferences-instance`; `apiKeys` / `integrations` /
 * `notifications.telegramBotToken` are `server-secrets`. That mapping is not
 * documentation — it is `SETTINGS_CLASSIFICATION` in `@podium/model`, and
 * `settings.classification.test.ts` fails if this object and that table
 * disagree in either direction.
 */
export const PodiumSettings = z.object({
  /** Every LLM/agent role on one unified shape (SP-6454 B3). Migrated from the
   *  legacy sessionDefaults/superagent/workLlm fields by `normalizeSettings`. */
  roles: Roles.default({}),
  /** Provider API keys. Stored plaintext in the self-hosted SQLite — same trust
   *  domain as the shell the agents already run in. `server-secrets`: never
   *  replicated and never enqueued once POD-419/POD-420 land. */
  apiKeys: ApiKeySecrets.default({}),
  integrations: IntegrationSecrets.default({}),
  hibernation: HibernationPolicy.default({}),
  notifications: NotificationSettings.default({}),
  sidebar: Sidebar.default({}),
  gitWorkflow: GitWorkflowPolicy.default({}),
  issues: IssueAssistantPolicy.default({}),
  /** The steward: the orchestrator's trigger queue over the durable event log
   *  (deterministic unblock nudges etc.). On by default (#470) [spec:SP-17db]:
   *  the feature has been live long enough to be trusted, and the dark default
   *  only broke NEW installs — their Notification triggers silently never fired.
   *  Existing installs are unaffected (the persisted `meta` value wins). */
  steward: StewardPolicy.default({}),
  /** When enabled, the server re-sends `continue` to any session stopped on a
   *  retryable error, on an escalating backoff up to 5 min. `promptDismissed`
   *  suppresses the one-time opt-in popup once the user has answered it. */
  autoContinue: AutoContinuePreferences.default({}),
  /**
   * User toggles for experimental features [spec:SP-f4b9].
   *
   * Draft Sync v2 (POD-859) lives here under `'draft-sync'`; the legacy bespoke
   * `draftSync.enabled` key is migrated onto it by `normalizeSettings` and dropped.
   */
  experimental: ExperimentalFlags.default({}),
})
export type PodiumSettings = z.infer<typeof PodiumSettings>

export const DEFAULT_SETTINGS: PodiumSettings = PodiumSettings.parse({})

/**
 * The old Codex "harness" backend shelled out to a bare, tool-less `codex exec`
 * — chat-only and prone to hanging, so it was folded onto the ChatGPT Responses
 * API. That stays true for the workLlm (a pure completion consumer). The
 * SUPERAGENT codex harness is back (issue #84): it now mounts Podium's MCP
 * tools per-invocation (declared by its harness manifest), so a saved codex-harness
 * superagent choice is honored, not migrated away.
 */
const LEGACY_HARNESS_MIGRATIONS: Partial<
  Record<HarnessAgent, (backend: LlmBackend) => LlmBackend>
> = {
  codex: (backend) => ({
    ...backend,
    kind: 'api',
    provider: 'codex',
    model:
      backend.harnessModel && backend.harnessModel !== 'auto' ? backend.harnessModel : 'gpt-5.5',
  }),
}

function migrateCodexHarness(b: LlmBackend): LlmBackend {
  if (b.kind !== 'harness') return b
  return LEGACY_HARNESS_MIGRATIONS[b.harnessAgent]?.(b) ?? b
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

/** Legacy `draftSync.enabled` → the canonical experiments store [spec:SP-f4b9].
 *  Draft Sync v2 (POD-859) moved onto `experimental['draft-sync']`; carry a
 *  persisted opt-in forward so an upgrade doesn't silently disable it, then let
 *  `PodiumSettings.parse` drop the now-unknown `draftSync` key (one source of
 *  truth). Returns the merged experimental record, or undefined when there is
 *  nothing to migrate (no legacy opt-in, or the standard key is already present). */
function migrateDraftSyncFlag(raw: Record<string, unknown>): Record<string, boolean> | undefined {
  const ds = raw.draftSync
  if (!ds || typeof ds !== 'object') return undefined
  if ((ds as Record<string, unknown>).enabled !== true) return undefined
  const exp =
    raw.experimental && typeof raw.experimental === 'object'
      ? (raw.experimental as Record<string, boolean>)
      : {}
  if (exp['draft-sync'] !== undefined) return undefined // an explicit toggle wins
  return { ...exp, 'draft-sync': true }
}

/** Parse a stored/transmitted blob, migrating the legacy backend fields onto
 *  `roles` and filling anything missing with defaults. */
export function normalizeSettings(raw: unknown): PodiumSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const roles = migrateRoles(obj)
  const experimental = migrateDraftSyncFlag(obj)
  return PodiumSettings.parse({
    ...obj,
    ...(roles ? { roles } : {}),
    ...(experimental ? { experimental } : {}),
  })
}

export interface ResolvedRole {
  accountId: AccountId
  execution: 'harness' | 'api'
  /** The harness to run (session roles) or the fallback harness (api roles). */
  harness: HarnessAgent
  /** Set when execution === 'api'. */
  provider?: ApiProvider
  model: string
  effort: string
}

const DEFAULT_ACCOUNT: Record<RoleName, AccountId> = {
  coding: nativeAccountId('claude-code'),
  // The orchestrator always runs a real harness with Podium's MCP tools. Keep its
  // empty/default account aligned with what the settings UI displays.
  superagent: nativeAccountId('claude-code'),
  background: managedAccountId('openrouter'),
}

const BACKGROUND_API_PROVIDERS: Partial<Record<HarnessAgent, ApiProvider>> = {
  codex: 'codex',
}

/** Decode a synthetic account id into an execution plan for a role. A native
 *  superagent account always means that harness. Background Codex remains the
 *  one special case: that one-shot consumer uses the ChatGPT Responses API. */
function decodeAccount(
  accountId: AccountId,
  role: RoleName,
): { execution: 'harness' | 'api'; harness: HarnessAgent; provider?: ApiProvider } {
  if (accountId.startsWith(HARNESS_ACCOUNT)) {
    const raw = accountId.slice(HARNESS_ACCOUNT.length)
    const harnessRaw = raw.split(':', 1)[0]
    const harness = HarnessAgent.safeParse(harnessRaw).success
      ? (harnessRaw as HarnessAgent)
      : 'claude-code'
    const backgroundProvider = BACKGROUND_API_PROVIDERS[harness]
    if (role === 'background' && backgroundProvider) {
      return { execution: 'api', harness, provider: backgroundProvider }
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
  // A native account already names its harness; a stale explicit harness must not
  // override it and make that account's model/effort leak to another CLI
  // [spec:SP-7ff1]. Managed credentials still need an explicit harness to choose
  // which CLI receives the injected credential.
  const nativeAccount = accountId.startsWith(HARNESS_ACCOUNT)
  if (rb.harness && !nativeAccount) {
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
