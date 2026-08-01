import { presenceCommand, sessionHandoffInput } from '@podium/commands'
import {
  AgentKind,
  ArtifactIdField,
  AutomationIdField,
  AutomationScheduleKind,
  AutomationSessionMode,
  asThreadId,
  asUserId,
  IssueIdField,
  isAgentKind,
  ResumeRef,
  SessionIdField,
  ThreadIdField,
  WorkState,
} from '@podium/model'
import { clientSwitchTraceSchema, type FileReadResultMessage } from '@podium/protocol'
import { PodiumSettings } from '@podium/runtime'
import { loadConfig, resolveUpdateChannel } from '@podium/runtime/config'
import {
  applyJoin,
  applyMode,
  applySetup,
  getUpdateChannel,
  NETWORK_OPTIONS,
  networkOptionCommand,
  setUpdateChannel,
  validatePublicUrl,
} from '@podium/runtime/setup'
import {
  readTelemetryState,
  resetInstallId,
  setConsent,
  shouldAskForConsent,
} from '@podium/telemetry'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { clearPassword, hasPassword, setPassword, verifyPassword } from './auth-store'
import {
  type CloudAgentKind,
  type CloudRepoRequest,
  type CloudRuntimeProvider,
  CloudRuntimeUnavailableError,
  disabledCloudRuntimeProvider,
  toCloudAgentSourceSession,
} from './cloud-runtime'
import { getFeatureStates } from './features'
import { buildJoinCommand } from './hub/machines-join'
import { accountFamilyProcedures } from './modules/accounts/trpc'
import { approvalFamilyProcedures } from './modules/approvals/trpc'
import { automationProcedures } from './modules/automations/trpc'
import { cloudFamilyProcedures } from './modules/cloud/trpc'
import { conversationFamilyProcedures } from './modules/conversations/trpc'
import { queryProcedures } from './modules/derived-family'
import { fileFamilyProcedures } from './modules/files/trpc'
import { DISCOVERY_QUERIES, REPO_QUERIES } from './modules/fleet/queries'
import { hostFamilyProcedures } from './modules/hosts/trpc'
import {
  authFamilyProcedures,
  setupFamilyProcedures,
  telemetryFamilyProcedures,
} from './modules/instance/trpc'
import { issueRegistry } from './modules/issues/registry'
import { routerFromCommands } from './modules/issues/trpc'
import { lockRegistry } from './modules/lock/registry'
import { lockRouterFromCommands } from './modules/lock/trpc'
import {
  AUTOMATION_QUERIES,
  FEATURE_QUERIES,
  GIT_QUERIES,
  QUOTA_QUERIES,
  SEARCH_QUERIES,
  SETTINGS_QUERIES,
  SPEC_QUERIES,
  SUPERAGENT_QUERIES,
  USAGE_QUERIES,
} from './modules/misc-queries'
import { modelFamilyProcedures } from './modules/models/trpc'
import { perfFamilyProcedures } from './modules/perf/trpc'
import {
  PIN_QUERIES,
  SESSION_QUERIES,
  SNOOZE_QUERIES,
  SYNC_QUERIES,
  TAB_QUERIES,
} from './modules/sessions/queries'
import { settingsAuthzDeps, settingsCommandsPermitted } from './modules/settings/authz'
import { settingsFamilyProcedures } from './modules/settings/trpc'
import { specsInputs } from './modules/specs/service'
import { specFamilyProcedures } from './modules/specs/trpc'
import { superagentFamilyProcedures } from './modules/superagent/trpc'
import type { RegistryModules } from './relay'
import { normalizeOriginUrl } from './repo-id'
import { browseDirectories } from './repo-registry'
import { isAllowedRoot } from './root-allowlist'
import { searchAll } from './search'

// The request Context, the shared `t` instance, and the ctx accessors live in
// ./trpc so the derived issues router (modules/issues/trpc.ts) shares them
// without a runtime cycle. Re-exported for existing import sites.
export { type Context, mods } from './trpc'

import type { AnyCommandContract } from '@podium/commands'
/**
 * THE DERIVED SESSION SURFACE (POD-382).
 *
 * Every session-family MUTATION — presence class, command plane and handoff — is
 * produced from the contract tables by `modules/sessions/trpc.ts` and spread into
 * the four routers below. There is deliberately no `.mutation(` for a session
 * anywhere in this file, and `scripts/audit-session-commands.ts` fails the build if
 * one appears: a hand-written procedure beside a derived one is a second answer to
 * "how is this authorized", which is what the 3.2 split set out to end.
 *
 * `sessions.ask` is the one session write NOT built there: POD-729 owns its
 * contract (it reaches delivery, so the mail table governs it), and it is served
 * below through that family's own derivation — `mailMutation('ask')`. The session
 * surface manifest records it with source `mail`, so the audit still sees it.
 *
 * The reads are still written out. They have no contracts yet (POD-311's remaining
 * work) and the audit checks procedure TYPE rather than name, so a write cannot hide
 * among them by being called a query.
 */
import { fleetProcedures } from './modules/fleet/trpc'
import { MAIL_COMMANDS, type MailProcName } from './modules/messages/registry'
import { visibleMachinesFor } from './modules/sessions/command-ctx'
import { PresenceRegistry, soleHumanPrincipal } from './modules/sessions/presence-registry'
import { presencePrincipal, sessionFamilyProcedures } from './modules/sessions/trpc'
import { workflowFamilyProcedures } from './modules/workflows/trpc'
import { type Context, mods, t } from './trpc'

/**
 * AGENT-MAIL DERIVATION (POD-729, the same join POD-380 applied to the presence
 * class).
 *
 * `mailMutation('send')` builds the tRPC procedure for a mail contract OUT OF
 * THE CONTRACT: its input schema is the contract's own instance — not a
 * restatement beside it and no longer `z.unknown()` — and its body is the
 * framework envelope: the exposure check, then dispatch into the one authz path.
 *
 * `z.unknown()` was not a small thing to remove. It meant the tRPC arm typed
 * nothing at all and shipped the payload to the gate for a second, private
 * parse; the CLIENT saw `unknown` at every call site, and a client sending a
 * malformed body learned about it from a thrown string rather than from a
 * validation error. One schema instance, read by both transports, is what ADR 3
 * D1 asks for.
 *
 * WHY TWO FUNCTIONS AND NOT ONE THAT BRANCHES. A single `mailProc` returning
 * `action === 'read' ? proc.query(run) : proc.mutation(run)` is what this was
 * first, and it typechecks perfectly in this package while DESTROYING the
 * client: `policy.action` is a union at the type level, so every procedure
 * inferred as `query | mutation` and `apps/web` lost `.query`/`.mutate` on all
 * nine. Splitting the verb into the function NAME is what keeps the inferred
 * router honest — and the derivation is not lost, because each helper CHECKS the
 * contract's action and refuses at module load if they disagree. The wire verb
 * and the authz action still cannot drift; the check just runs at boot instead
 * of in the type system.
 *
 * That distinction matters most for `messages.inbox`, which looks like a read
 * and is a `write` because it CONSUMES. A hand-written router is exactly where
 * that gets quietly "corrected" by someone who trusts the name.
 *
 * Deliberately NOT the full transport derivation POD-382 owns: the procedures
 * are still listed by name below, so the SHAPE of the router stays reviewable in
 * this diff. What is gone is every hand-written body.
 */
function mailContractFor(name: MailProcName, expected: 'read' | 'write'): AnyCommandContract {
  const { contract } = MAIL_COMMANDS[name]
  // A command this router serves must SAY it serves tRPC. Failing at module load
  // rather than at call time: a procedure that refuses everything at runtime is
  // the "green gate that stopped looking" failure mode, and it looks identical
  // to a procedure nobody happened to call.
  if (!contract.exposure.includes('trpc')) {
    throw new Error(`mailProc: ${contract.name} is not exposed on trpc`)
  }
  // THE DERIVATION, as a boot-time check. `mailQuery('inbox')` is a compile-time
  // no-op and a runtime crash, which is the right way round: a consuming read
  // served as a query would widen it to viewer-grade principals.
  if (contract.policy.action !== expected) {
    throw new Error(
      `mailProc: ${contract.name} declares action '${contract.policy.action}' but is served as a ${expected === 'read' ? 'query' : 'mutation'}`,
    )
  }
  return contract
}

function mailRun<Out>(name: MailProcName) {
  return ({ ctx, input }: { ctx: Context; input: unknown }): Promise<Out> =>
    // Non-null asserted because the exposure check already proved the dispatcher
    // will not answer `undefined` for this name on this transport.
    mods(ctx).messageGate.dispatch(
      ctx.capability,
      ctx.overrideScope,
      name,
      input,
      'trpc',
    )! as Promise<Out>
}

/** A mail contract whose policy action is `write`, served as a tRPC mutation. */
function mailMutation<Out = unknown>(name: MailProcName) {
  return t.procedure.input(mailContractFor(name, 'write').input).mutation(mailRun<Out>(name))
}

/** A mail contract whose policy action is `read`, served as a tRPC query. */
function mailQuery<Out = unknown>(name: MailProcName) {
  return t.procedure.input(mailContractFor(name, 'read').input).query(mailRun<Out>(name))
}

/**
 * THE DERIVED SESSION-FAMILY PROCEDURES (POD-382), built once at module load.
 *
 * Spread into the four session-family routers below. Building them here rather than
 * inline is what keeps `sessions`/`pins`/`snoozes`/`tabs` readable as the shape they
 * serve, while the CONTRACT TABLES decide the membership.
 */
const sessionFamily = sessionFamilyProcedures()

/** The seven superagent thread mutations, built from their contracts at module
 *  load (POD-383). Built once here for the same reason as `sessionFamily`: the
 *  spread stays readable at the router while the CONTRACT TABLE decides the
 *  membership — including that there are seven and not eight. */
const superagentFamily = superagentFamilyProcedures()

/** The three spec writes, built from their contracts at module load (POD-386).
 *  Built here for the same reason as `sessionFamily` and `superagentFamily`: the
 *  spread stays readable beside the three reads the `specs` router also serves,
 *  while the CONTRACT TABLE decides the membership. */
const specFamily = specFamilyProcedures()

/** The four settings writes, built from their contracts at module load
 *  (POD-420). Same shape as `specFamily`: the CONTRACT TABLE decides membership,
 *  and the spread stays readable beside the read and the three hand-written
 *  procedures the `settings` router also serves. */
const settingsFamily = settingsFamilyProcedures()

import type { PinState, SnoozeMap } from './store/types'

/**
 * THE DERIVED FLEET-FAMILY PROCEDURES (POD-384), built once at module load and
 * spread into the `machines` / `repos` / `discovery` routers below.
 *
 * The hub-role gate moved WITH them: it is no longer a `hubProc` each fleet
 * procedure had to remember to use, it is derived from each contract's
 * `serverRole` in `modules/fleet/trpc.ts`. The 404-on-wrong-role behaviour is
 * unchanged — that is the acceptance criterion — but it now follows a
 * declaration rather than a call-site habit.
 *
 * `joinCommand` is the one thing the module cannot import for itself:
 * `hub/machines-join` is hub-role code and `roles.ts` rule 1 forbids core from
 * importing it. This file is a composition root, so it supplies the port.
 */
const fleet = fleetProcedures({
  joinCommand: (pairCode) => {
    const config = loadConfig()
    const publicUrl = config.publicUrl
    return publicUrl
      ? buildJoinCommand({ publicUrl, pairCode, channel: resolveUpdateChannel(config) })
      : null
  },
})

export const appRouter = t.router({
  /**
   * THE CLOUD SURFACE IS DERIVED (POD-314) — provisioning and lifecycle for
   * HOSTED runtimes. The ~150 lines of `moveSession` logic that used to sit
   * inline here now live in `modules/cloud/service.ts`, where the ORDER of its
   * six decisions is documented and reachable by a test without standing up a
   * tRPC caller.
   */
  cloud: t.router(cloudFamilyProcedures()),
  sessions: t.router({
    // WRITES — THE DERIVED SURFACE (POD-382). create · resume · kill · handoff ·
    // continue · sendText · answerAskUserQuestion · resumeAndSend · hibernate ·
    // stop · resurrect · uploadImage · rename · setArchived · markRead ·
    // markUnread · setIssueId · setWorkState, every one built from its contract
    // by modules/sessions/trpc.ts. Which commands exist is the CONTRACT TABLE's
    // answer, including which transports serve them — which is why `setDraft` is
    // absent (it declares `ws`).
    ...sessionFamily.sessions,
    // READS — the query table (POD-314). Declared in modules/sessions/queries.ts;
    // they carry no contract because a visibility class describes what a command
    // WRITES, and audit-session-commands.ts checks procedure TYPE so a write
    // cannot hide among them.
    ...queryProcedures('sessions', SESSION_QUERIES),
    // THE ONE SESSION WRITE NOT BUILT BY `sessionFamilyProcedures()`, and the
    // merge is why. POD-382 had given `ask` a command-plane contract to delete
    // the last hand-written body; POD-729 landed first with `ask` cut over to the
    // MAIL table, because it reaches DELIVERY and a send path no contract governs
    // is the hole that cutover closed. Two contracts for one command is a fork,
    // so the duplicate was deleted and this stays the mail family's — derived by
    // `mailMutation`, recorded in the session-surface manifest with source `mail`
    // so the audit still refuses a hand-written one here.
    ask: mailMutation('ask'),
  }),
  sync: t.router(queryProcedures('sync', SYNC_QUERIES)),
  // PER-USER STATE (POD-380): each list is the CALLER's, not the instance's.
  pins: t.router({ ...queryProcedures('pins', PIN_QUERIES), ...sessionFamily.pins }),
  // set: until === null => "until next message"; ISO string => timed.
  snoozes: t.router({ ...queryProcedures('snoozes', SNOOZE_QUERIES), ...sessionFamily.snoozes }),
  /**
   * DERIVED (POD-383) plus its two reads. `superagent.send` USED TO LIVE HERE, a
   * byte-identical alias of `sendTurn` forwarding to the same service method. It
   * is deleted: eleven callers name `sendTurn` and none has ever named `send`, so
   * POD-1075's rule — persistence decides between two names for one thing —
   * retires the alias rather than the entry.
   */
  superagent: t.router({
    ...queryProcedures('superagent', SUPERAGENT_QUERIES),
    ...superagentFamily,
  }),
  conversations: t.router(conversationFamilyProcedures()),
  search: t.router(queryProcedures('search', SEARCH_QUERIES)),
  settings: t.router({
    ...queryProcedures('settings', SETTINGS_QUERIES),
    // Whole-object set: the client always round-trips the full blob, so there is
    // no partial-merge ambiguity. PodiumSettings fills defaults for missing keys.
    // REFUSES a secret change (`assertNoSecretChange`), so the only way to write
    // credential material is the derived, online-sensitive, admin-grade pair.
    // ON BEHALF OF THE CALLER (POD-1213): the blob it posts spans two homes now,
    // and the personal leaves land on the caller's own rows. The split is the
    // store's, by classification — this seam supplies only WHO.
    set: t.procedure
      .input(PodiumSettings)
      .mutation(({ ctx, input }) =>
        mods(ctx).settings.setSettingsFor(
          asUserId(soleHumanPrincipal(ctx.capability).userId),
          input,
        ),
      ),
    /**
     * WHICH SETTINGS COMMANDS THIS CALLER MAY ATTEMPT (POD-421).
     *
     * The brief's rule is that an admin-grade control must be rendered
     * DISABLED WITH A STATED REASON rather than editable-then-refused, and
     * that requires the client to know the answer before the attempt. This is
     * how it learns it.
     *
     * IT IS DERIVED FROM THE SAME GATE THE SERVER ENFORCES —
     * `settingsCommandsPermitted` calls `settingsAuthzFailure`, once per
     * command — so the disabled state and the refusal cannot disagree. A UI
     * computing its own answer from a second rule is exactly how a control
     * ends up enabled for a write the server refuses.
     *
     * IT IS NOT A CAPABILITY SNAPSHOT, and POD-352's exit audit turns on the
     * distinction. Nothing here is stored, enqueued, or attached to a contract
     * or an outbox entry: it is recomputed per request from the live account
     * role, and the server re-runs the identical gate at apply time whatever
     * the client believed (ADR 3 D8). The client's copy is a rendering hint
     * with no authority.
     *
     * HAND-WRITTEN, and the reason is the same one that keeps `settings.get`
     * hand-written: a `visibility` class names the state a command WRITES, and
     * this describes the CALLER rather than any settings state. Giving it one
     * would be a well-typed lie of the kind POD-1075 refused. It is named as
     * an exception in `router.settings-guard.test.ts` and counted by
     * `scripts/audit-settings-commands.ts`, so the exception is visible rather
     * than assumed.
     */
    viewer: t.procedure.query(({ ctx }) => ({
      permitted: settingsCommandsPermitted(settingsAuthzDeps(ctx)),
    })),
    ...settingsFamily,
  }),
  perf: t.router(perfFamilyProcedures()),
  // Experimental feature flags [spec:SP-f4b9] — same auth as settings.get.
  features: t.router(queryProcedures('features', FEATURE_QUERIES)),
  telemetry: t.router(telemetryFamilyProcedures()),
  /**
   * THE ACCOUNT SURFACE IS DERIVED (POD-314) — the Accounts & Keys hub
   * (SP-6454): native CLI logins on this machine (observed read-only) plus the
   * managed credentials Podium holds. Read at call-time, never cached as truth,
   * and never returning a credential — only its masked `identity`.
   */
  accounts: t.router(accountFamilyProcedures()),
  // PER-USER STATE (POD-380): the caller's saved orders.
  tabs: t.router({ ...queryProcedures('tabs', TAB_QUERIES), ...sessionFamily.tabs }),
  // setPrefix · add · addMany · remove — DERIVED (POD-384). Store-level
  // validation (^[A-Z]{2,5}$, server-wide prefix uniqueness, absolute paths) is
  // unchanged and still surfaces as BAD_REQUEST with the store's message.
  repos: t.router({ ...queryProcedures('repos', REPO_QUERIES), ...fleet.repos }),
  usage: t.router(queryProcedures('usage', USAGE_QUERIES)),
  quota: t.router(queryProcedures('quota', QUOTA_QUERIES)),
  models: t.router(modelFamilyProcedures()),
  /**
   * THE HOST SURFACE IS DERIVED (POD-314) — who owns the used memory right now.
   * Roots are derived SERVER-SIDE from the target machine's registered repos plus
   * their worktrees (worktrees often live OUTSIDE the repo path as siblings, so
   * the repo path alone would miss their dev servers), which is why the command
   * cannot be pointed at an arbitrary path.
   */
  hosts: t.router(hostFamilyProcedures()),
  discovery: t.router({
    // CONVERSATION discovery, not repo discovery — `rpc.scan()` returns
    // `{ conversations, diagnostics }`. It shares this router's name and nothing
    // else, so POD-384 deliberately left it out of the fleet contract table and
    // the census allowlists it BY KEY on this router only.
    scan: t.procedure.mutation(({ ctx }) => mods(ctx).rpc.scan()),
    // refreshRepos · scanFolder · scanMachine — DERIVED (POD-384): the three
    // `machineVerb: 'use'` commands, each placing a filesystem walk on the target
    // machine's daemon.
    ...fleet.discovery,
    ...queryProcedures('discovery', DISCOVERY_QUERIES),
  }),
  machines: t.router({
    /**
     * THE ONE READ LEFT HAND-WRITTEN IN THIS FILE, and the reason is worth
     * stating because everything else moved. `visibleMachinesFor` is an
     * AUTHORIZATION PROJECTION: it scopes the list to what this principal may
     * see and attaches each machine's `use` decision, so that one it cannot
     * execute on is never OFFERED (readiness §3.1.4 M5) and one it cannot see is
     * simply absent. It therefore needs the CAPABILITY, which the derived state
     * bundle deliberately withholds — a handler that could read the capability
     * could make an authorization decision, which is precisely what
     * modules/derived-family.ts exists to prevent. Widening the bundle for this
     * single read would trade that property away; leaving one procedure here
     * costs four lines. When POD-1075 lands a real principal this is where it
     * belongs.
     */
    list: t.procedure.query(({ ctx }) => visibleMachinesFor(mods(ctx), ctx.capability)),
    // rename · revoke · pairingCode — DERIVED (POD-384). All three are hub-role
    // by contract (`serverRole: 'hub'`), which is where the 404 now comes from.
    ...fleet.machines,
  }),
  setup: t.router(setupFamilyProcedures()),
  /**
   * THE AUTH SURFACE IS DERIVED (POD-314) — the human-client login password on
   * an already-configured instance. These run under the same /trpc guard, so
   * once a password is set you must be logged in to reach them; the CURRENT
   * password is ALSO required for a change/disable, which defends against a
   * hijacked session. In open mode the current check is skipped — bootstrap.
   */
  auth: t.router(authFamilyProcedures()),
  // The issues surface is DERIVED from the command registry (#248
  // [spec:SP-3fe2]): one definition per command (modules/issues/registry.ts)
  // carries input schema, action/scope/target authz, and the handler; the
  // capability guard reads authz from the DEFINITION (no path-string parsing),
  // and the daemon relay + MCP dispatch run the SAME pipeline.
  issues: routerFromCommands(issueRegistry),
  // Advisory named lease locks [spec:SP-85d1] — same derivation pattern, over
  // the lock registry (role-gated only; no issue-scope targets).
  lock: lockRouterFromCommands(lockRegistry),
  // Unified agent messaging (#237) [spec:SP-34d7]: the `podium mail` surface.
  // Input validation + authz live in the MessageGate (shared verbatim with the
  // daemon relay arm); the gate stamps the sender from ctx.capability.
  // Unified agent messaging (#237) [spec:SP-34d7]: the `podium mail` surface.
  //
  // DERIVED (POD-729). Every procedure below is built from its contract in
  // `@podium/commands` — input schema, wire verb and authz all come from the one
  // table, and the hand-written bodies that used to sit here (nine `z.unknown()`
  // procedures wrapping a stringly-typed dispatch) are DELETED. Input validation
  // and authz live in the MessageGate, shared VERBATIM with the daemon relay arm;
  // the gate stamps the sender from ctx.capability, never from payload.
  //
  // ZERO hand-written `.mutation(` in this router is the POD-424 gate criterion,
  // and `router.mail-derivation.test.ts` asserts it against this file's TEXT —
  // an audit that reads the source is the only kind that notices the tenth
  // procedure someone adds by hand next year.
  messages: t.router({
    send: mailMutation('send'),
    // A mutation on the wire, because the recipient's own inbox read CONSUMES
    // queued status. The contract says `write`; the verb follows the contract.
    inbox: mailMutation('inbox'),
    dismiss: mailMutation('dismiss'),
    show: mailQuery('show'),
    // Sender-queryable message lifecycle (#834) [POD-834 §04d]: "what happened to
    // msg X" — mayView-gated in the gate (sender/recipient/admin), a pure read.
    status: mailQuery('status'),
    // The web ledger view (#237) [spec:SP-34d7 web]: per-issue / per-session
    // delivery ledger. Own traffic for a member, cross-user at admin grade.
    ledger: mailQuery('ledger'),
    reply: mailMutation('reply'),
    // Cross-harness subagents (#237) [spec:SP-34d7 cross-harness]: `podium
    // agent spawn/await`. The child is a full Podium session; await is BOUNDED
    // (returns a snapshot, never hangs).
    spawnAgent: mailMutation('spawnAgent'),
    awaitAgent: mailMutation('awaitAgent'),
  }),
  git: t.router(queryProcedures('git', GIT_QUERIES)),
  files: t.router(fileFamilyProcedures()),
  // pspec — the living spec tree in <repo>/pspec/ (modules/specs over
  // apps/server/src/pspec.ts). Prototype scope: local-filesystem repos only
  // (reads/writes on the server host). The repo-root allowlist gate lives in
  // the SpecsService so the daemon-relay path enforces the identical check.
  /**
   * THE WORKFLOW SURFACE IS DERIVED (POD-732, the 3.10 cutover).
   *
   * Eighteen hand-written procedures — eleven of them `.mutation(` — are gone.
   * `workflowFamilyProcedures()` builds all of them from `WORKFLOW_CONTRACTS`
   * and `WORKFLOW_QUERIES`, so there is deliberately no procedure written out
   * here, and `scripts/audit-workflow-commands.ts` fails the build if one
   * appears.
   */
  workflows: t.router(workflowFamilyProcedures()),
  /**
   * SCHEDULED AUTOMATIONS (#470) [spec:SP-17db] — the cron half of the Automations
   * tab, and a DERIVED SURFACE since POD-735 (the 3.11 cutover).
   *
   * The four writes — create · update · setEnabled · remove — are built from
   * `AUTOMATION_CONTRACTS` by `modules/automations/trpc.ts`, so there is
   * deliberately no mutation written out here and
   * `scripts/audit-automation-commands.ts` fails the build if one appears. The two
   * READS stay hand-written: a contract's `visibility` classifies what a command
   * WRITES, and a read writes nothing.
   *
   * OPERATOR-ONLY is now a declaration rather than an omission. It was true only
   * because `RELAY_ALLOWED` happens to have no `automations` key; the contracts say
   * it (`operatorOnly`, exposure `['trpc']`), the derived builder refuses at module
   * load to serve a contract that grew an agent transport, and
   * `automation-cutover.audit.test.ts` drives the real relay gate to prove the
   * refusal with a positive control beside it.
   */
  automations: t.router({
    ...queryProcedures('automations', AUTOMATION_QUERIES),
    ...automationProcedures(),
  }),
  /**
   * THE SPEC SURFACE IS DERIVED (POD-386, the 3.3d cutover). `create · save ·
   * remove` are built from `SPEC_CONTRACTS` by `specFamilyProcedures()`; the
   * three reads carry no contract — a `visibility` class describes what a command
   * WRITES — and are authorized by the identical `requireRepoRoot` call inside
   * the service.
   */
  specs: t.router({ ...queryProcedures('specs', SPEC_QUERIES), ...specFamily }),
  approvals: t.router(approvalFamilyProcedures()),
})

export type AppRouter = typeof appRouter
