import type { VisibilityClass } from '@podium/model'
import type { MachineVerb } from '@podium/protocol'
import type { z } from 'zod'

/**
 * Command-definition contract for the P3 command registry [spec:SP-3fe2]:
 * one declarative table per namespace from which the tRPC router, the CLI
 * surface, and the MCP tool surface are all derived. P1 only defines the
 * contract — nothing registers commands yet.
 */

/**
 * What a command requires of the caller's role. This is EXACTLY the
 * `IssueAction` vocabulary of packages/model/src/issue-authz.ts (viewer=read
 * · worker=+write · admin=+manage) — the same literals PROC_ACTION classifies
 * every issues.* proc with. Defined here rather than imported because
 * @podium/protocol is a leaf package (zod-only, no workspace deps); keep in
 * lockstep with IssueAction.
 */
export type CommandAction = 'read' | 'write' | 'manage'

/**
 * What kind of EXISTING target a write/manage command mutates — the registry
 * generalization of the SCOPED_TARGET table (packages/model/src/
 * issue-authz.ts, re-exported by apps/server/src/issue-authz.ts):
 *
 * - `issue` — the command targets an existing issue and is subtree-scope
 *   gated, i.e. it would carry a SCOPED_TARGET extractor today;
 * - `repo` — the command targets a repo/worktree (cwd-scoped capability);
 * - `global` — no per-target scope gate beyond the role gate.
 *
 * Omitted ⇒ the command is additive or self-addressed (SCOPED_TARGET's
 * deliberate non-entries: create, mailSend, attachSession, subscription*) —
 * role-gated only, exactly like a PROC_ACTION entry without a SCOPED_TARGET
 * extractor.
 */
export type CommandScope = 'issue' | 'repo' | 'global'

/**
 * ---------------------------------------------------------------------------
 * THE FOUR METADATA FACETS (POD-380, for POD-311's `packages/commands`)
 * ---------------------------------------------------------------------------
 *
 * ADR 3 requires four things of a command contract that `action`/`scope` above
 * cannot express, and POD-311's brief enumerates them: **policy** (which
 * resource, whose, which verb), **exposure** (which transports serve it — opt-in,
 * default-closed), **offline** (delivery class), and **redaction** (which input
 * fields never reach a log or a persisted envelope).
 *
 * They live HERE rather than in a new package because this file already IS the
 * contract framework's home. POD-311 relocated the command definition here, and
 * a second framework built next to it is precisely what that instruction forbids.
 * Creating `packages/commands` here would also take a new-package scaffolding
 * commit the ledger assigns to POD-311.
 *
 * All four are OPTIONAL on `CommandDef` so the ~70 issue/lock defs that predate
 * them still compile. That is deliberately NOT a default: `exposure` absent means
 * *no transport*, never *every transport* (see {@link commandExposure}). Read the
 * facets through the accessors below rather than off the field, so the
 * default-closed rule has exactly one implementation.
 */

/** A transport a command may be served on. Exposure is OPT-IN per transport. */
export type CommandTransport = 'trpc' | 'relay' | 'cli' | 'mcp' | 'ws'

/**
 * Whose authority a write answers to — the policy's *scope* half, distinct from
 * {@link CommandScope}'s target-class half.
 *
 * - `owner-or-grant` — the entity has an owner; the principal must be that owner
 *   or hold a grant on it (docs/multi-user-readiness.md §3.1.1 personal class).
 * - `self` — the row IS the principal's: per-user state keyed `(userId,
 *   entityId)`. A principal may write only its own row (§3.3), so this is not a
 *   weaker `owner-or-grant` but a different rule: it is NON-GRANTABLE (ADR 9 D3
 *   rule 4 — there is no "share my read state" verb).
 * - `subtree` — today's agent-capability rule (`IssueScope.subtree`).
 * - `tenant` — deployment substrate, readable tenant-wide (§3.1.1).
 */
export type PolicyScope = 'owner-or-grant' | 'self' | 'subtree' | 'tenant'

/** The resource class a policy names. `per-user-state` is the §3.3 family. */
export type PolicyResource = 'session' | 'issue' | 'repo' | 'machine' | 'per-user-state'

/**
 * A command's authorization policy: a resource and whose it is, not a role class
 * alone. §3.1.3 A1's live evaluation means this is data the enforcement point
 * reads at EVERY apply (including an outbox drain), never a capability frozen at
 * enqueue time.
 */
export interface CommandPolicy {
  resource: PolicyResource
  scope: PolicyScope
  /** Verb, in the same vocabulary as {@link CommandAction}. */
  action: CommandAction
  /**
   * ADDITIONALLY required on the machine the target lives on (POD-381, ADR 3
   * Amendment 1 D18 / ADR 9 D6). A command can name a `session` resource and
   * still be an execution request: spawning, reattaching, typing into a PTY and
   * killing a process all run code on someone's hardware with THEIR ssh keys,
   * git identity and private checkouts.
   *
   * It is a SECOND axis rather than `resource: 'machine'` because collapsing
   * them would lose the row gate: `sessions.kill` is authorized against the
   * session's owner AND against `use` on its machine, and D15.2 says neither
   * substitutes for the other.
   *
   * The type is the handshake's `MachineVerb`, aliased below, not a second
   * declaration of the same three literals — that file already owns the
   * vocabulary beside the `MachineGrant` edge and the `machineUseAllowed`
   * all-in-one guard that reads it.
   *
   * Declaring `'use'` makes `offline: 'online-only'` a CONSEQUENCE rather than a
   * judgement call (D18.3): a queued execution command is a rights snapshot with
   * a delayed fuse. `session-commands-plane.test.ts` enforces the implication.
   */
  machineVerb?: MachineVerb
}

/** See {@link CommandPolicy.machineVerb}. */
export type { MachineVerb }

/**
 * Delivery class (ADR 3 D4), and the one facet whose values are already pinned by
 * a shipped product decision rather than chosen here:
 *
 * - `eligible` — may be queued in the client Outbox and drained on reconnect,
 *   which is only sound because idempotency is framework-owned and ADR 3 D8
 *   re-authorizes at apply time.
 * - `direct-only` — never enqueued; the write is low offline value or its replay
 *   would be worse than its failure. It fails fast when offline.
 * - `online-only` — additionally requires a live counterparty (a daemon, a
 *   re-auth) and so cannot even be retried blindly.
 *
 * The `eligible` / `direct-only` split for the session-state class is NOT a new
 * decision: POD-379's outbox oracle pins the covered set (rename, setArchived,
 * setWorkState, markRead, markUnread, snoozes.set, snoozes.clear) and the
 * deliberate exclusions (pins, tab order — "low offline value"), tagged
 * must-not-change. A contract that widens it changes product behaviour.
 */
export type OfflineClass = 'eligible' | 'direct-only' | 'online-only'

/**
 * Which input fields must never appear in a log line, a persisted mutation
 * envelope, or an error message. Empty `fields` is a POSITIVE statement ("nothing
 * in this input is sensitive"), which is why the facet is a record rather than an
 * optional array: `{ fields: [] }` is reviewed, absent is not.
 */
export interface CommandRedaction {
  /** Top-level input keys to redact. */
  fields: readonly string[]
  /** Why — so a reviewer can tell a considered empty list from a forgotten one. */
  note?: string
}

/**
 * ADR 1's conflict-class vocabulary, declared on the contract so the arbitration
 * rule travels with the command instead of living only in a doc table.
 *
 * `op-stream` is §4's carve-out: a per-document ordered op stream SEQUENCED BY THE
 * AUTHORITY, which keeps collaborative text open without a CRDT and without the
 * Replica ever arbitrating. Declaring it on a contract that does not yet ship op
 * transport is the RESERVATION — see the composer-draft contract.
 */
export type ConflictClass =
  | 'exp-rev'
  | 'field-LWW'
  | 'single-writer'
  | 'append'
  | 'cmd'
  | 'op-stream'

/**
 * {@link ConflictClass} plus the WRITTEN `'n/a'` a command with no replicated row
 * answers with — the vocabulary a CONTRACT declares, as opposed to the six an
 * ARBITRATION LOOKUP resolves.
 *
 * Lives here, beside `ConflictClass`, because `CommandDef` below has to hold one:
 * `defineCommands` constrains a registry's defs to `CommandDef`, so a def whose
 * `conflict` is narrower than what its contract actually carries makes that
 * constraint fail — and it fails SILENTLY, by widening the inferred defs table
 * until every command reads as possibly-undefined rather than by naming the field.
 * That is how POD-1250 found it. The full argument for the member is on
 * `ContractConflictClass` in `contract.ts`, which re-exports this.
 */
export type ContractConflictClass = ConflictClass | 'n/a'

/**
 * THE VISIBILITY CLASS OF WHAT A COMMAND WRITES (POD-382; ADR 9 D3/D4, readiness
 * §3.1.1 rules 1 and 2).
 *
 * `policy` already says WHOSE authority a write answers to. This says which of ADR
 * 9's five classes the state it writes belongs to — the question a scoped feed and
 * a share dialog both ask, and the one nothing on this contract could answer
 * before. The vocabulary is `@podium/model`'s `VisibilityClass`, imported rather
 * than restated: a local union with the same five members typechecks, encodes
 * identically and drifts the first time ADR 9 gains a class.
 *
 * IT IS OPTIONAL ON THE TYPE AND MANDATORY ON THE SESSION FAMILY, and those are
 * two different mechanisms on purpose (the same split `visibilityClassOf` and
 * `matrix.test.ts` already carry for entity classes):
 *
 *   - {@link commandVisibility} resolves an absent declaration to `personal` —
 *     private to its owner, never tenant-visible. The SEMANTIC backstop, which
 *     holds with every test deleted.
 *   - `scripts/audit-session-commands.ts` FAILS THE BUILD when a session-family
 *     command omits it. Forgetting to classify must fail toward privacy AND
 *     toward a red build; neither substitutes for the other.
 *
 * It is a DECLARATION, not a derivation from `policy.resource`, even though the
 * two agree on every contract today and the audit checks that they agree. Deriving
 * it would make the implication silent and unauditable, and would erase the place a
 * legitimate exception could be written down and reviewed.
 */
export type { VisibilityClass }

export interface CommandDef<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown> {
  /** Input schema — the one validation source for tRPC/CLI/MCP alike. */
  input: In
  /** Role requirement, IssueAction vocabulary (see {@link CommandAction}). */
  action: CommandAction
  /** Existing-target scope class (see {@link CommandScope}); omit for additive commands. */
  scope?: CommandScope
  /** CLI derivation hints: positional argument order + one-line summary. */
  cli?: { positional?: string[]; summary?: string }
  /** AUTHZ POLICY — resource + whose + verb (see {@link CommandPolicy}). */
  policy?: CommandPolicy
  /** TRANSPORT EXPOSURE — opt-in per transport; absent ⇒ served nowhere. */
  exposure?: readonly CommandTransport[]
  /** DELIVERY CLASS (see {@link OfflineClass}). */
  offline?: OfflineClass
  /** SENSITIVE-FIELD REDACTION (see {@link CommandRedaction}). */
  redaction?: CommandRedaction
  /** ADR 1 conflict class this command's target arbitrates under. `'n/a'` is the
   *  answer for a command with no replicated row — see {@link ContractConflictClass}. */
  conflict?: ContractConflictClass
  /** VISIBILITY CLASS of the state this command writes — see {@link VisibilityClass}
   *  above. Absent ⇒ `personal` (default-closed); required on the session family. */
  visibility?: VisibilityClass
  /** Free-text decision record: a fork resolved on this contract, so the
   *  reasoning ships with the code rather than only in a commit message. */
  decision?: string
  /** Phantom output marker so `Out` survives inference; never set at runtime. */
  readonly __out?: Out
}

/**
 * THE default-closed exposure read (POD-311 AC: *"a contract without explicit
 * exposure is served on NO transport"*). One implementation, so no transport can
 * grow its own `?? ALL_TRANSPORTS` fallback — forgetting to classify must fail
 * toward refusal, the same rule §3.1.1 states for visibility.
 */
export function commandExposure(def: CommandDef): readonly CommandTransport[] {
  return def.exposure ?? []
}

/**
 * THE default-closed visibility read (ADR 9 D4, readiness §3.1.1 rule 1): an
 * undeclared command writes `personal` state — private to its owner, never
 * tenant-visible, never substrate.
 *
 * One implementation, like {@link commandExposure}, so no surface can grow its own
 * `?? 'deployment-substrate'` convenience.
 */
export function commandVisibility(def: CommandDef): VisibilityClass {
  return def.visibility ?? 'personal'
}

/** Whether `transport` may serve `def`. The single exposure gate. */
export function isExposedOn(def: CommandDef, transport: CommandTransport): boolean {
  return commandExposure(def).includes(transport)
}

/**
 * Declare one namespace's command table. Runtime-trivial (it just pairs the
 * pieces); the value is in inference — `NS` and the per-key defs stay literal,
 * so {@link CommandName} can produce the dotted names carried by
 * `OutboxCommand.name`.
 */
export function defineCommands<NS extends string, T extends Record<string, CommandDef>>(
  namespace: NS,
  defs: T,
): { namespace: NS; defs: T } {
  return { namespace, defs }
}

/** The dotted command names of a defineCommands result: 'namespace.key'. */
export type CommandName<R extends { namespace: string; defs: Record<string, CommandDef> }> =
  `${R['namespace']}.${Extract<keyof R['defs'], string>}`

/**
 * THE canonical issue-command name list USED TO LIVE HERE, hand-maintained as an
 * `as const` array of sixty-eight strings beside a registry that had to be kept in
 * step with it. POD-311 replaced it with a DERIVATION: `ISSUE_COMMAND_NAMES` is now
 * `Object.keys(ISSUE_CONTRACTS).sort()` in `issues/contracts.ts`, so a name cannot
 * exist without a contract and neither list can drift from the other because there
 * is only one. The `satisfies` pin on the server registry and the `IssueTrpc` client
 * key both read the derived union, unchanged in meaning.
 *
 * It is called out rather than deleted silently because a reader who remembers the
 * array will otherwise assume it was lost.
 */

/**
 * THE canonical lock-command name list [spec:SP-85d1] — the def keys of the
 * server's `lock` registry (advisory named lease locks), declared here for the
 * same reason the issue list exists (see the note above): the server registry is
 * `satisfies`-checked against it and @podium/issue-client keys its
 * `IssueTrpc.lock` client shape off the same union.
 */
export const LOCK_COMMAND_NAMES = [
  'acquire',
  'cancel',
  'release',
  'renew',
  'status',
  'steal',
] as const

/** One lock-command def key — see {@link LOCK_COMMAND_NAMES}. */
export type LockCommandName = (typeof LOCK_COMMAND_NAMES)[number]

/** The parsed input type of one command definition. */
export type CommandInput<D extends CommandDef> = z.infer<D['input']>

/** The output type one command definition promises. */
export type CommandOutput<D extends CommandDef> =
  D extends CommandDef<z.ZodTypeAny, infer Out> ? Out : never
