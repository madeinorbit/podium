import type { z } from 'zod'

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

export interface CommandDef<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown> {
  /** Input schema — the one validation source for tRPC/CLI/MCP alike. */
  input: In
  /** Role requirement, IssueAction vocabulary (see {@link CommandAction}). */
  action: CommandAction
  /** Existing-target scope class (see {@link CommandScope}); omit for additive commands. */
  scope?: CommandScope
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
  'ready',
  'refreshAssistant',
  'reparent',
  'restore',
  'search',
  'setLabels',
  'setNeedsHuman',
  'setState',
  'stale',
  'start',
  'stats',
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
