/**
 * SETTINGS — THE PREFERENCE HALVES (POD-418, 3.7a).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * `PodiumSettings` (`packages/runtime/src/settings.ts`) is ONE instance-wide JSON
 * blob holding three things that ADR 1's matrix puts on three different rows:
 *
 *   | matrix row              | class                  | this file           |
 *   |-------------------------|------------------------|---------------------|
 *   | `preferences-personal`  | `per-user-state`       | {@link PersonalPreferences}  |
 *   | `preferences-instance`  | `deployment-substrate` | {@link InstancePreferences}  |
 *   | `server-secrets`        | `secret`               | `./secrets.ts`      |
 *
 * The blob's leaf schemas are DECLARED HERE and the blob COMPOSES them: runtime
 * re-exports these bindings rather than redeclaring them, the way `HarnessAgent`
 * already moved at POD-300. That direction matters more than the file layout —
 * a parallel set of "split" shapes beside a composite that still owns its own
 * leaves is two definitions of one vocabulary, and the drift between them would
 * be invisible until a scrub migration read the wrong one.
 *
 * So the split is STRUCTURAL, and `classification.ts` derives its totality from
 * these shapes rather than from a hand list of path strings.
 *
 * **This file does not move any storage.** POD-419 owns the client scrub
 * migration and POD-420 the command contracts. What lands here is the model they
 * both read: which leaves are whose, and which are never allowed to leave the
 * server.
 *
 * ---------------------------------------------------------------------------
 * THE LINE BETWEEN THE TWO PREFERENCE HALVES
 * ---------------------------------------------------------------------------
 *
 * A **preference is personal when it DIFFERS PER READER**, and it is keyed
 * `(userId)` — POD-365's fragment with no entity half ({@link
 * PerUserSingletonKey}). POD-351 and POD-731 both paid for the inverse mistake:
 * a `readAt`/snooze/pins-shaped field given a `personal` contract, which keys a
 * per-user fact as a shared one and then needs a table migration plus a wire
 * change plus a replica migration to undo. {@link AutoContinuePreferences} is
 * exactly that shape — `promptDismissed` is "have *I* answered this popup" — and
 * it is keyed per user here for that reason.
 *
 * A **preference is instance-level when every reader must resolve it
 * IDENTICALLY**. `gitWorkflow.mergeStyle` is the sharp case and it is decided
 * here rather than defaulted: two people merging one repo under two merge styles
 * is not two preferences being honoured, it is one repo with two histories. Same
 * for `steward.enabled` and `issues.assistantEnabled` — a server-side job either
 * runs or does not; there is no per-reader answer for it to have.
 *
 * `hibernation` is the case worth naming because it looks personal and is not:
 * it is a MACHINE resource policy (a memory ceiling and an idle-session
 * convergence target). ADR 9 D3 rule 3 says a fact about a machine inherits the
 * machine's scoping, and the machine is not the reader's. Recorded as
 * deployment-substrate with that reason, per the brief's instruction to name the
 * third case rather than let it fall to a default.
 */

import { z } from 'zod'
import { HarnessAgent } from '../entities/agent'
import { PerUserSingletonKey } from '../fields/per-user-key'
import { AccountIdField } from '../ids'
import { asAccountId } from '../ids/brands'

// ---------------------------------------------------------------------------
// PERSONAL — the `(userId)`-keyed halves
// ---------------------------------------------------------------------------

/** One role's backend over a single shape (the unified model — SP-6454 B3).
 *  `accountId` names the auth source (a synthetic derived id today, e.g.
 *  'native:claude-code' or 'managed:anthropic'; '' = the role's default). The
 *  account determines execution (harness vs api) + provider/harness; `model` +
 *  `effort` layer on top. `harness` makes that choice explicit for persisted UI
 *  selections and can later select a harness for a managed credential; native
 *  superagent accounts imply their harness even on older settings blobs.
 *
 *  THE ACCOUNT REFERENCE IS NOT THE CREDENTIAL. `accountId` names a row on the
 *  `managed-credentials` matrix row, whose VALUES never replicate — but the id
 *  itself is a reference, and a reference is exactly what a client needs in order
 *  to render "which account is this role using" without ever holding the
 *  material. That is the same presence-not-value shape `./secrets.ts` gives the
 *  in-blob secrets. */
export const RoleBackend = z.object({
  /** `AccountIdField` (brand-only), NOT the `.min(1)` `AccountId` schema: '' is a
   *  DOCUMENTED value here meaning "the role's default", so a validating schema
   *  would reject settings blobs that parse today (POD-362). */
  accountId: AccountIdField.default(asAccountId('')),
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
  /** Seed spawned agent CLIs with per-session OFFICIAL theme flags so their
   *  rendering follows the terminal's issue-tinted colours (Claude Code
   *  `--settings {"theme":"auto"}`, Codex `-c tui.theme=ansi`). Default ON;
   *  off = no flags at all, the CLI's own theme behaviour is untouched. Podium
   *  never edits a user's global CLI config either way. [spec:SP-a04d] */
  seedCliTheme: z.boolean().default(true),
})
export type CodingRole = z.infer<typeof CodingRole>

/** Every LLM/agent role, one shape each. `coding` = new interactive sessions,
 *  `superagent` = the orchestrator, `background` = one-shot work (issue
 *  assistant, title generation, summaries).
 *
 *  PERSONAL, and §3.1.6 S1 is why: the superagent is *"you, automated"* — a
 *  delegation from ONE human with that human's scope. A role backend that was
 *  instance-wide would make one person's model choice everybody's. */
export const Roles = z.object({
  coding: CodingRole.default({}),
  superagent: RoleBackend.default({}),
  background: RoleBackend.default({ model: 'google/gemini-2.5-flash' }),
})
export type Roles = z.infer<typeof Roles>
export type RoleName = keyof Roles

/** Sidebar layout. Layout is per person by definition (matrix `tab-order`'s
 *  conflict note says exactly that about its sibling). */
export const Sidebar = z.object({
  repoSort: z.enum(['alphabetical', 'lastUsed', 'custom']).default('lastUsed'),
  repoOrder: z.array(z.string()).default([]),
  groupByRepo: z.boolean().default(false),
})
export type Sidebar = z.infer<typeof Sidebar>

/**
 * Auto-continue: re-send `continue` to a session stopped on a retryable error.
 *
 * THE PER-USER-STATE SHAPE, NAMED. `promptDismissed` suppresses a one-time
 * opt-in popup once *the reader* has answered it — the same shape as `readAt`,
 * snooze and pins, and the exact field POD-351/POD-731 warn against giving a
 * `personal`-but-shared contract. `enabled` rides with it rather than being
 * split off: it governs what happens to the reader's OWN sessions, which are a
 * `personal` class with an owner, so an instance-wide answer would make one
 * person's retry policy apply to another person's agents.
 */
export const AutoContinuePreferences = z.object({
  enabled: z.boolean().default(false),
  promptDismissed: z.boolean().default(false),
})
export type AutoContinuePreferences = z.infer<typeof AutoContinuePreferences>

/**
 * WHERE A NOTIFICATION GOES — routing, not secrets (ADR 9 D8 S4).
 *
 * `telegramChatId` is on this side deliberately and the matrix records the
 * reason: it is ROUTING CONFIG, and classifying it as a secret would break the
 * per-user notification routing §3.1.6 S3 depends on. The bot TOKEN is the
 * secret and lives in `./secrets.ts` — one nested object in today's blob, two
 * matrix rows, and this file is where that seam is drawn.
 *
 * The consequence recorded on the matrix row and repeated here because it is
 * easy to skip: a per-user superagent makes the INBOUND Telegram edge an
 * authentication surface. An arriving message must resolve to a USER before
 * anything acts on it, and UNKNOWN CHATS MUST FAIL CLOSED — never fall back to
 * an operator identity.
 */
export const NotificationRouting = z.object({
  web: z.boolean().default(true),
  /** ntfy.sh topic for mobile push (empty = off). */
  ntfyTopic: z.string().default(''),
  /** Telegram chat id or @channelusername for global server push (empty = off). */
  telegramChatId: z.string().default(''),
})
export type NotificationRouting = z.infer<typeof NotificationRouting>

/**
 * THE PERSONAL PREFERENCE AGGREGATE — matrix row `preferences-personal`,
 * `per-user-state`, replicated server→clients and OFFLINE-EDITABLE.
 *
 * Keyed `(userId)` through {@link PerUserSingletonKey}: one row per person, not
 * one blob per instance. Offline-editable is the property POD-419's outbox needs
 * and is why this half is a separate aggregate from the secrets at all — an
 * outbox that could enqueue a generic `settings.set` would persist secrets into
 * browser and mobile replica storage (POD-352). Two aggregates make that a shape
 * mismatch rather than a rule someone has to remember.
 *
 * No `visibility` field, for the reason `perUserKey` gives: per-user state is
 * non-grantable BY CONSTRUCTION (ADR 9 D3 rule 4), so the class is a matrix
 * annotation on the family and never a per-row value a writer could set wrong.
 */
export const PersonalPreferences = PerUserSingletonKey.extend({
  roles: Roles.default({}),
  sidebar: Sidebar.default({}),
  autoContinue: AutoContinuePreferences.default({}),
  notifications: NotificationRouting.default({}),
})
export type PersonalPreferences = z.infer<typeof PersonalPreferences>

// ---------------------------------------------------------------------------
// INSTANCE — the deployment-substrate half
// ---------------------------------------------------------------------------

/**
 * Idle-session hibernation policy.
 *
 * INSTANCE, NOT PERSONAL, and this is the case the brief asks to be named rather
 * than defaulted. Every member is a MACHINE resource decision — a host memory
 * ceiling and a per-machine idle-live convergence target — and ADR 9 D3 rule 3
 * puts facts about a machine under the machine's scoping, which is not the
 * reader's. A per-user memory ceiling is not a preference that can be honoured:
 * the host has one amount of memory.
 */
export const HibernationPolicy = z.object({
  enabled: z.boolean().default(true),
  /** Hibernate idle sessions once host memory use crosses this percentage. */
  memoryPct: z.number().int().min(50).max(95).default(80),
  /** Per-machine idle-live convergence target [spec:SP-c29e]. Null is
   * unlimited; zero is valid and parks every session that passes the safety
   * gates. */
  maxIdleSessions: z.number().int().min(0).nullable().default(30),
  /** A session counts as idle after this many minutes without activity. */
  idleMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(30),
})
export type HibernationPolicy = z.infer<typeof HibernationPolicy>

/**
 * Branch and merge policy.
 *
 * INSTANCE. `mergeStyle` is the sharpest argument for the whole distinction:
 * two people merging one repo under two merge styles is not two preferences
 * being honoured, it is one repo with two histories. A shared artifact needs one
 * answer, which is ADR 9 D3 rule 1's coordination-name reasoning applied to a
 * workflow rather than to a lock.
 */
export const GitWorkflowPolicy = z.object({
  /** Parent branch for new issue worktrees + merge target. '' = auto-detect repo default. */
  defaultParentBranch: z.string().default(''),
  mergeStyle: z.enum(['ff-only', 'pr', 'ask']).default('ff-only'),
  autoRebaseBeforeMerge: z.boolean().default(true),
})
export type GitWorkflowPolicy = z.infer<typeof GitWorkflowPolicy>

/** Whether the server-side issue assistant runs. INSTANCE: a server-side job
 *  either runs or it does not, and there is no per-reader answer for it. */
export const IssueAssistantPolicy = z.object({
  assistantEnabled: z.boolean().default(true),
})
export type IssueAssistantPolicy = z.infer<typeof IssueAssistantPolicy>

/** The steward: the orchestrator's trigger queue over the durable event log
 *  (deterministic unblock nudges etc.). On by default (#470) [spec:SP-17db].
 *  INSTANCE, same reason as {@link IssueAssistantPolicy} — and note ADR 9 D8 S5:
 *  the steward is a SYSTEM automation with no human behind it, so it is not a
 *  personal agent whose settings could be someone's. */
export const StewardPolicy = z.object({
  enabled: z.boolean().default(true),
})
export type StewardPolicy = z.infer<typeof StewardPolicy>

/**
 * User toggles for experimental features [spec:SP-f4b9]. Keys are feature ids
 * from the protocol registry; unknown ids are kept (a flag may exist in a
 * newer/older build) and are harmless. Honored only while the flag is listed for
 * this install — see `resolveFeatureState`.
 *
 * INSTANCE, and the matrix row says so explicitly: `settings.experimental` is a
 * PREFERENCE, intentionally replicated, and carries no secret annotation. The
 * name reads "user toggles" and the class is deployment-substrate — that is not
 * a contradiction, it is the D3 rule 1 floor: a feature flag decides which CODE
 * PATH the deployment runs, and two readers cannot run two builds.
 *
 * An OPEN record rather than a closed enum, because the flag ids come from the
 * protocol registry and a build may meet a blob from another build. That
 * openness is why `classification.ts` classifies this leaf as a WHOLE and can
 * make no claim about individual flag ids — see `SETTINGS_OPEN_RECORD_LEAVES`.
 */
export const ExperimentalFlags = z.record(z.string(), z.boolean())
export type ExperimentalFlags = z.infer<typeof ExperimentalFlags>

/**
 * THE INSTANCE PREFERENCE AGGREGATE — matrix row `preferences-instance`,
 * `deployment-substrate`, replicated server→clients, offline-eligible,
 * field-LWW per key (the only surviving field-LWW member, Amendment 1 D10).
 *
 * No owner and no per-row key: it is a property of the DEPLOYMENT, not of a
 * person (ADR 9 D3 rule 1), which is exactly why it is NOT keyed by user the way
 * {@link PersonalPreferences} is. Writing it is admin-grade (ADR 9 D1.4's
 * `isAdminGrade`); READING it is not, and the distinction is the row's, not this
 * shape's.
 */
export const InstancePreferences = z.object({
  hibernation: HibernationPolicy.default({}),
  gitWorkflow: GitWorkflowPolicy.default({}),
  issues: IssueAssistantPolicy.default({}),
  steward: StewardPolicy.default({}),
  experimental: ExperimentalFlags.default({}),
})
export type InstancePreferences = z.infer<typeof InstancePreferences>
