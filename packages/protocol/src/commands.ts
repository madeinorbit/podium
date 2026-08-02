import { Revision } from '@podium/model'
import { z } from 'zod'
import { MutationId } from './ids'

/**
 * Command-definition contract for the P3 command registry [spec:SP-3fe2]:
 * one declarative table per namespace from which the tRPC router, the CLI
 * surface, and the MCP tool surface are all derived. P1 only defines the
 * contract — nothing registers commands yet.
 */

/**
 * What a command requires of the caller's role. This is EXACTLY the
 * `IssueAction` vocabulary of packages/domain/src/issue-authz.ts (viewer=read
 * · worker=+write · admin=+manage) — the same literals PROC_ACTION classifies
 * every issues.* proc with. Defined here rather than imported because
 * @podium/protocol is a leaf package (zod-only, no workspace deps); keep in
 * lockstep with IssueAction.
 */
export type CommandAction = 'read' | 'write' | 'manage'

/**
 * What kind of EXISTING target a write/manage command mutates — the registry
 * generalization of the SCOPED_TARGET table (packages/domain/src/
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
 * The concurrency rule a MUTATING command commits to [ADR 3 D13.2] — "declared
 * per contract, not guessed". Each kind names one notation from ADR 1's
 * ownership matrix, so a definition is traceable to the row that decided it:
 *
 * - `expected-revision` — ADR 1's `exp-rev`: the write is based on a specific
 *   prior state, so the envelope carries {@link RevisionedCommandEnvelope}'s
 *   `expectedRevision` and the authority refuses a stale one (ADR 3 D13.3).
 * - `append` — ADR 1's `append`, plus an entity's birth: there is no prior
 *   revision to be stale against. `mutationId` dedupe is the only guard, and it
 *   is the RIGHT one (a replayed create must not mint a second issue).
 * - `command-specific` — ADR 1's `cmd` (and `field-LWW`): the command's own
 *   preconditions ARE the rule — a lease machine, a live-path spawn, a
 *   last-write-wins flag. `rule` states it, because a reader must not have to
 *   infer a concurrency posture from a handler body.
 */
export type CommandConcurrency =
  | { kind: 'expected-revision' }
  | { kind: 'append' }
  | { kind: 'command-specific'; rule: string }

/**
 * The idempotency key on a mutating command envelope [ADR 3 D1]. Client-minted
 * (the outbox PK) and the authority's `applied_mutations` dedupe key: a replay
 * inside the receipt horizon returns the stored result instead of re-running
 * (ADR 2 D11.7).
 *
 * Composed from {@link MutationId} rather than re-declared, with the 128-char
 * bound the durable receipt PK has always carried.
 */
export const CommandMutationId = MutationId.refine(
  (s) => s.length <= 128,
  'mutationId must be at most 128 characters',
)

/** The envelope fields EVERY mutating command carries [ADR 3 D1]. */
export const CommandEnvelope = z.object({
  mutationId: CommandMutationId.optional(),
})

/**
 * The envelope of a mutating command whose ADR 1 row uses expected-revision
 * concurrency [ADR 3 D13.1]. `expectedRevision` composes @podium/model's
 * {@link Revision} — the authority-assigned per-entity token of ADR 2 D3, not a
 * clock and not a feed position.
 *
 * OPTIONAL, deliberately: the field is *declared* on every exp-rev contract now,
 * but no caller can supply one until the replica carries revisions (POD-795) and
 * the wire cuts over (POD-796). Supplied ⇒ the authority enforces it; omitted ⇒
 * last-write-wins, exactly as today. Requiring it here would reject every
 * shipped CLI/agent/MCP write on day one.
 */
export const RevisionedCommandEnvelope = CommandEnvelope.extend({
  expectedRevision: Revision.optional(),
})

export interface CommandDef<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown> {
  /** Input schema — the one validation source for tRPC/CLI/MCP alike. */
  input: In
  /** Role requirement, IssueAction vocabulary (see {@link CommandAction}). */
  action: CommandAction
  /** Existing-target scope class (see {@link CommandScope}); omit for additive commands. */
  scope?: CommandScope
  /** The mutating command's concurrency rule (see {@link CommandConcurrency}).
   *  Required on every mutation by the registry's own def helper; absent on reads. */
  concurrency?: CommandConcurrency
  /** CLI derivation hints: positional argument order + one-line summary. */
  cli?: { positional?: string[]; summary?: string }
  /** Phantom output marker so `Out` survives inference; never set at runtime. */
  readonly __out?: Out
}

/**
 * Declare one namespace's command table. Runtime-trivial (it just pairs the
 * pieces); the value is in inference — `NS` and the per-key defs stay literal,
 * so {@link CommandName} can produce the dotted wire names the
 * MutationEnvelope's `command` field carries.
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
 * THE canonical issue-command name list [spec:SP-3fe2 #248] — the def keys of the
 * server's `issues` registry, declared HERE (the leaf contract package) so both
 * sides of the wire compile against ONE source:
 *
 *  - apps/server's registry is checked `satisfies Record<IssueCommandName, …>`,
 *    so adding/renaming/removing a command without touching this list is a
 *    compile error, not a silent authz/wire drift;
 *  - @podium/issue-client keys its `IssueTrpc.issues` client shape off the same
 *    union, so a CLI/MCP command body calling an unknown or renamed proc breaks
 *    compilation instead of failing at runtime.
 *
 * Names are the BARE def keys ('close', not 'issues.close'); the dotted wire
 * form is derived via {@link CommandName} where needed.
 */
export const ISSUE_COMMAND_NAMES = [
  'action',
  'addComment',
  'addSession',
  'addShell',
  'answerQuestion',
  'applySuggestion',
  'archive',
  'attachSession',
  'blocked',
  'children',
  'claim',
  'cleanup',
  'clearNeedsHuman',
  'close',
  'closeEligibleEpics',
  'comments',
  'count',
  'create',
  'defer',
  'delete',
  'depAdd',
  'depRemove',
  'depReport',
  'dismissSuggestion',
  'doctor',
  'duplicate',
  'epicStatus',
  'events',
  'findDuplicates',
  'get',
  'graph',
  'integrate',
  'linearSearch',
  'lint',
  'list',
  'mailClaim',
  'mailInbox',
  'mailPending',
  'mailSend',
  'markRead',
  'markUnread',
  'orphans',
  'panelApply',
  'preflight',
  'prime',
  'promote',
  'ready',
  'refreshAssistant',
  'reparent',
  'restore',
  'search',
  'setCoordinator',
  'setLabels',
  'setNeedsHuman',
  'setState',
  'setTucked',
  'stale',
  'start',
  'stats',
  'stop',
  'subscriptionAdd',
  'subscriptionList',
  'subscriptionRemove',
  'subscriptionSetEnabled',
  'supersede',
  'tree',
  'undefer',
  'update',
] as const

/** One issue-command def key — see {@link ISSUE_COMMAND_NAMES}. */
export type IssueCommandName = (typeof ISSUE_COMMAND_NAMES)[number]

/**
 * Output caps the bounded issue READ commands apply server-side. Declared here
 * because two sides must agree on them: the server enforces them, and the CLI
 * names the cap (and the flag that raises it) in its truncation footer. A cap
 * the notice quotes wrongly is worse than no notice, so neither side hardcodes
 * its own copy.
 */
export const ISSUE_TREE_DEFAULT_MAX_DEPTH = 3
export const ISSUE_TREE_DEFAULT_MAX_NODES = 100
export const ISSUE_EVENTS_DEFAULT_LIMIT = 200

/**
 * THE canonical lock-command name list [spec:SP-85d1] — the def keys of the
 * server's `lock` registry (advisory named lease locks), declared here for the
 * same reason as {@link ISSUE_COMMAND_NAMES}: the server registry is
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
