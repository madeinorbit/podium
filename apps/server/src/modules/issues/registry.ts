import {
  type CommandAction,
  type ConflictClass,
  type ContractConflictClass,
  type ContractInput,
  defineCommands,
  ISSUE_CONTRACTS,
  type IssueContractName,
} from '@podium/commands'
import type {
  IssueAllowedActions,
  IssueId,
  IssueSessionSummaryEntry,
  MutationId,
  SessionId,
  UserId,
} from '@podium/model'
import {
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asIssueId,
  asUserId,
  authorize,
  isAgentComputing,
  isDecisionIssue,
  isIssueClosed,
  isPersonCapability,
  issueAllowedActions,
  SHARED_MACHINE_ACCOUNT_WARNING,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import { attributionOf, onBehalfOfUser } from '../../command-principal'
import { checkIssueAccess } from '../../issue-authz'
import { withReadScope } from '../../store/executor/read-scope'
import { ShippingOrderAccessError } from '../shipping/service'
import type { IssueCaller, IssueCommandAccess, IssueCommandCtx } from './command-ctx'
import { eventsForMember } from './event-visibility'
import { isCommentAuthor } from './service/mail'
import { IssueNotFound } from './service/not-found'
import type { IssueCommandResult } from './service/reads'
import { IssueRefusal } from './service/refusal'
import { becameCoordinatorText, seatRefusal, seatText } from './service/seat'

/**
 * THE ISSUE COMMAND TABLE: every issue command's handler, joined to its L1
 * contract (#248 [spec:SP-3fe2], split by POD-311, reduced to the table alone by
 * POD-1398).
 *
 * THIS FILE IS NOW ONE THING — a declaration table. It was three (POD-1398): the
 * table, the per-call execution context handed to every handler, and the
 * dispatcher that runs one. The god-object audit refuses that shape by name,
 * "a table that also ships an object is two things in one file, and the object
 * is the half nobody reviewed" (scripts/audit-god-objects.ts), and the reason
 * generalises past the audit: a reader who wants to check ONE row of the table
 * had to scroll past a class they were not reviewing, and a reader auditing the
 * dispatch pipeline had to scroll past sixty-eight rows they were not reviewing.
 *
 * The seam is the dependency order the code already had, and it is now the file
 * order too — each module imports only from the one before it:
 *
 *   `command-ctx.ts`  IssueCaller, IssueCommandDeps, IssueCommandCtx —
 *                     everything a handler is HANDED.
 *   `registry.ts`     this file: the rows, the `def()` join, and the guard that
 *                     reads a row's `action`/`target`. Handlers reference
 *                     {@link IssueCommandCtx} as a TYPE only, so the table adds
 *                     no runtime edge back.
 *   `dispatcher.ts`   IssueCommandDispatcher — how a row is CHOSEN and run. The
 *                     only module that needs both of the others at runtime, and
 *                     nothing imports it back.
 *
 * IT USED TO BE BOTH HALVES OF THE CONTRACT JOIN as well. It declared each
 * command's input schema,
 * required action and scope class alongside a handler bound to one capability —
 * which made an L1 contract table live inside an L3 feature module, the arrangement
 * POD-311 finding 1 rules out. The contract half now lives in
 * `@podium/commands`'s `issues/contracts.ts`; what stays here is the half that
 * genuinely belongs to the feature:
 *
 *   - the HANDLER, which calls a narrow L3 capability interface (and therefore
 *     may not live beside the L1 contract);
 *   - `kind`, the tRPC procedure type it mounts as — a transport fact;
 *   - `target`, the raw-input extractor the capability guard and the viaHub
 *     forwarding detection both read.
 *
 * `def('<name>', { … })` IS THE JOIN. It looks the contract up by name and merges
 * its `input` and `policy.action` onto the handler record, so every derived surface
 * keeps reading `def.input` / `def.action` exactly as before and no transport needed
 * a line changed. The name argument is typed `IssueContractName`, so a handler for a
 * command with no contract — or a contract with no handler — is a compile error
 * rather than a surface that quietly serves nothing.
 *
 * The four surfaces are DERIVED from the joined table:
 *
 *   - the tRPC `issues:` sub-router (modules/issues/trpc.ts routerFromCommands),
 *   - the in-process command surface serving the daemon relay + MCP
 *     (`IssueCommandDispatcher` in `./dispatcher`, replacing the hand-mirrored
 *     IssueCommandService of modules/issues/commands.ts),
 *   - the relay gate's dispatch (relay-gate.ts is transport-only now),
 *   - the `IssueTrpc` client the in-process MCP tools call
 *     (`IssueCommandDispatcher.asIssueTrpc`, replacing the Proxy soup).
 *
 * Authorization is declared on the CONTRACT (`policy.action` + `policy.resource`)
 * and the extractor that feeds it stays here — replacing the PROC_ACTION /
 * SCOPED_TARGET string maps keyed by proc name, so renaming a command still moves
 * its authz with it instead of silently resetting to 'read'. The def keys are
 * pinned to `ISSUE_CONTRACTS` via `satisfies`, so handler↔contract drift is a
 * compile error in both directions.
 */

/**
 * THE D13 SUMMARY of every agent session on a task (design §2.3, POD-6288):
 * whose it is, its title, and whether it is working. What a task reader learns
 * about sessions that are not theirs; never their content, ids or controls.
 */
async function sessionSummaries(
  ctx: IssueCommandCtx,
  issue: { id: IssueId; worktreePath: string | null },
): Promise<IssueSessionSummaryEntry[]> {
  const all = (await ctx.deps.listSessionsForIssue(issue.worktreePath, issue.id)).filter(
    (session) => session.agentKind !== 'shell',
  )
  if (all.length === 0) return []
  const rows = await ctx.deps.executionFacts.store.sessions.getSessions(
    all.map((session) => session.sessionId),
  )
  return all.map((session) => ({
    owner: rows.get(session.sessionId)?.ownerUserId ?? null,
    title: session.name ?? session.title,
    state: isAgentComputing(session) ? 'live' : 'idle',
  }))
}

/**
 * WHAT THIS READER MAY DO FROM THE TASK PAGE (POD-6295): the `write` decision
 * the dispatcher would make for this task, without `--outside-scope` (the page
 * cannot confirm one), and whether the reader is a person in person.
 */
async function allowedActions(ctx: IssueCommandCtx, id: IssueId): Promise<IssueAllowedActions> {
  const capability = ctx.caller.capability
  const write = authorize(
    capability,
    'write',
    capability.scope.kind === 'subtree'
      ? { id, ancestorIds: await ctx.hierarchy.ancestorIds(id) }
      : { id },
  )
  return issueAllowedActions(write, personHuman(ctx) !== undefined)
}

/** What `issues.share` and `issues.unshare` answer (POD-6288). */
export const TASKS_VISIBLE_TO_ALL_MEMBERS =
  'tasks are visible to all members; there is nothing to share or unshare'

async function refuseTaskSharing(ctx: IssueCommandCtx, id: string): Promise<never> {
  // An unknown task answers as one, like every other targeted command.
  if (!(await ctx.reports.getMeta(id))) throw new IssueNotFound(id)
  throw new IssueRefusal(TASKS_VISIBLE_TO_ALL_MEMBERS)
}

/**
 * THE ASSIGNEE A COMMAND NAMES (POD-6287, design §2.2, §4.3).
 *
 * The assignee is the task's owner, its one accountable human. Only a person
 * changes it, to any active member; `me` is that person. An agent never does,
 * not even to its own human: an agent acting does not change who answers for
 * the task (MU-24). The refusal names the rule, because an agent following an
 * old habit (`claim --assignee me`) is told what happened instead of guessing.
 */
/** Who an edit is recorded under (POD-6289): the caller's actor and the human
 *  it acts for, from the authenticated principal; nothing when there is none. */
function textAttribution(ctx: IssueCommandCtx): {
  attribution?: { actor: string | null; onBehalfOf: string | null }
} {
  const principal = ctx.caller.principal
  return principal ? { attribution: attributionOf(principal) } : {}
}

async function assigneeNamed(ctx: IssueCommandCtx, raw: string): Promise<UserId> {
  const human = personHuman(ctx)
  if (human === undefined) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        "an agent cannot change a task's assignee: the assignee is a person, and only a person reassigns",
    })
  }
  const target = raw.trim() === 'me' ? human : asUserId(raw.trim())
  if (!(await ctx.crud.isActiveMember(target))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `cannot assign to ${raw}: the assignee must be an active member (a member id, or "me")`,
    })
  }
  return target
}

/**
 * `--assignee me|all|<member>` (POD-6296), resolved here so every transport
 * (CLI, relay, MCP) narrows the same way: `me` is the caller's own human, for
 * an agent the human it acts for. `fallback` is the listing's default.
 */
async function assigneeScope(
  ctx: IssueCommandCtx,
  raw: string | undefined,
  fallback: 'me' | 'all',
): Promise<UserId | undefined> {
  return await ctx.reports.assigneeScope(raw, ctx.markerUser(), fallback)
}

/** A search filter with its assignee resolved to a member id, or dropped for `all`. */
async function assigneeFiltered<T extends { assignee?: string | undefined }>(
  ctx: IssueCommandCtx,
  filter: T,
): Promise<Omit<T, 'assignee'> & { assignee?: UserId }> {
  const { assignee, ...rest } = filter
  const scope = await assigneeScope(ctx, assignee, 'all')
  return scope ? { ...rest, assignee: scope } : rest
}

/** An agent's write scope as its root's ref, or `null` when it has none. */
async function agentScopeRef(ctx: IssueCommandCtx): Promise<string | null> {
  const scope = ctx.caller.capability.scope
  if (scope.kind !== 'subtree') return null
  const row = await ctx.reports.getMeta(scope.rootId)
  return row ? await ctx.reports.niceRef(row) : null
}

/**
 * A REASSIGNING WRITE'S MUTATION ID, PER MEMBER (POD-6287, MU-17). The
 * mutation ledger keys a receipt on the id alone, so a second member sending
 * the same id would be answered with the first member's recorded result and
 * have nothing applied. A reassignment is keyed to the member who sent it:
 * each member's own retry still replays, and nobody is answered with someone
 * else's receipt.
 */
function memberMutationId(
  ctx: IssueCommandCtx,
  mutationId: MutationId | undefined,
): MutationId | undefined {
  const human = ctx.markerUser()
  return mutationId && human ? (`${mutationId}@${human}` as MutationId) : mutationId
}

/** The person calling, in person (not an agent): whose subscriptions a
 *  subscription command may touch (POD-6288). */
function personHuman(ctx: IssueCommandCtx): UserId | undefined {
  return isPersonCapability(ctx.caller.capability) ? ctx.markerUser() : undefined
}

async function sessionOwnedBy(
  ctx: IssueCommandCtx,
  sessionId: string,
  human: UserId,
): Promise<boolean> {
  const rows = await ctx.deps.executionFacts.store.sessions.getSessions([sessionId])
  return rows.get(sessionId)?.ownerUserId === human
}

/**
 * A SUBSCRIBER IS A PERSON'S OWN (POD-6288) when it is a session they own or a
 * task assigned to them. Per-user state (design §4.1): admins get the same.
 * Returns the subscriber with a task ref resolved to its id, or refuses.
 */
async function ownSubscriberOrRefuse(
  ctx: IssueCommandCtx,
  subscriber: { kind: 'session' | 'issue'; id: string },
  human: UserId,
): Promise<{ kind: 'session' | 'issue'; id: string }> {
  if (subscriber.kind === 'session') {
    if (await sessionOwnedBy(ctx, subscriber.id, human)) return subscriber
  } else {
    const row = await ctx.reports.getMeta(subscriber.id).catch(() => null)
    if (row && row.ownerUserId === human) return { kind: 'issue', id: row.id }
  }
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'you may subscribe only your own sessions or tasks assigned to you',
  })
}

/** Refuse a remove or toggle of a subscription that is not the caller's own:
 *  a person's own subscriber (above), or an agent's derived subscriber. */
async function assertOwnSubscription(
  ctx: IssueCommandCtx,
  id: string,
  verb: 'remove' | 'toggle',
): Promise<void> {
  const human = personHuman(ctx)
  let owned: boolean
  if (human !== undefined) {
    const sub = await ctx.attention.subscriptionGet(id)
    owned =
      sub !== undefined &&
      (sub.subscriberKind === 'session'
        ? await sessionOwnedBy(ctx, sub.subscriberId, human)
        : (await ctx.reports.getMeta(sub.subscriberId).catch(() => null))?.ownerUserId === human)
  } else {
    const subscriber = ctx.deriveSubscriber()
    owned = (await ctx.attention.subscriptionList({ subscriberId: subscriber.id })).some(
      (s) => s.id === id,
    )
  }
  if (!owned) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `not allowed to ${verb} a subscription you do not own`,
    })
  }
}

/** The human starting a session on a task (POD-6283): the person, or the human
 *  at the root of an agent's delegation. That session is theirs, whoever owns
 *  the task. A system job has no human, and the task's owner stands in. */
function startedOnBehalfOf(ctx: IssueCommandCtx): { onBehalfOf?: UserId } {
  const principal = ctx.caller.principal
  const human = principal ? attributionOf(principal).onBehalfOf : ctx.caller.capability.onBehalfOf
  return human ? { onBehalfOf: human } : {}
}

/**
 * WORKING IN A TASK'S WORKTREE NEEDS `use` ON ITS MACHINE (POD-6296, design §5
 * Q4). A task keeps one worktree on one machine. Bob may start work in Alice's
 * task only where he holds `use`; reading or editing her task grants nothing
 * on a machine (§2.4). Without it he works through his own sub-task, which
 * gets its own worktree on his own machine. With it, the run goes ahead with
 * the shared-machine warning: both people's agents share that OS account.
 *
 * The gate is the caller's human's own standing, narrowed by an agent's
 * delegation; the assignee's rights are never consulted, so no start adopts
 * them. It applies to work on someone else's task and to work on a machine in
 * someone else's custody; a person's own task on their own machine (every task
 * on a one-member instance) is untouched.
 */
async function workMachineGate(
  ctx: IssueCommandCtx,
  id: string,
  verb: string,
): Promise<{ warning?: string }> {
  const principal = ctx.caller.principal
  const human = principal ? (onBehalfOfUser(principal) ?? undefined) : undefined
  if (!principal || !human || !ctx.deps.machineStanding) return {}
  const row = await ctx.reports.getMeta(id)
  if (!row) return {}
  const machineId = await ctx.gitWorkflow.workMachine(row.id, human)
  const standing = await ctx.deps.machineStanding(principal, machineId)
  const theirs = row.ownerUserId !== human
  const elsewhere = standing.custodian !== null && standing.custodian !== human
  if (!theirs && !elsewhere) return {}
  const ref = await ctx.reports.niceRef(row)
  if (!standing.use) {
    throw new IssueRefusal(
      theirs
        ? `cannot ${verb} ${ref}: its worktree is on ${standing.name}, where you have no \`use\`. ` +
            `Work on it through your own sub-task instead; it gets its own worktree on your machine: ` +
            `\`podium issue create --parent-id ${ref} --title "…" --machine <your machine> --start\``
        : `cannot ${verb} ${ref}: it is homed on ${standing.name}, where you have no \`use\`. ` +
            `Start it on your own machine: \`podium issue start ${ref} --machine <your machine>\``,
    )
  }
  if (!elsewhere) return {}
  return {
    warning: `${ref} runs on ${standing.name}, a machine in someone else's custody. ${SHARED_MACHINE_ACCOUNT_WARNING}`,
  }
}

/**
 * A COORDINATOR SEAT IS ITS OWN HUMAN'S (POD-6296, MU-21). The coordinator
 * marker decides whom sessions on a task ask and where its mail goes first, so
 * setting it is an effect on the session it names. Bob may name only a session
 * of his own human, and may not replace or clear a coordinator that acts for
 * someone else while it still exists: Alice's agent keeps the seat she gave it.
 * Bob coordinates his own work through his own sub-task. On a one-member
 * instance every session is the caller's, and nothing changes.
 */
async function assertOwnCoordinatorSeat(
  ctx: IssueCommandCtx,
  id: string,
  next: SessionId | null,
): Promise<void> {
  const human = ctx.markerUser()
  if (!human) return
  const row = await ctx.reports.getMeta(id)
  if (!row) return
  const current = row.coordinatorSessionId ?? null
  const ids = [...new Set([next, current].filter((s): s is SessionId => s !== null))]
  if (ids.length === 0) return
  const sessions = await ctx.deps.executionFacts.store.sessions.getSessions(ids)
  const ref = await ctx.reports.niceRef(row)
  if (next !== null && sessions.get(next) && sessions.get(next)?.ownerUserId !== human) {
    throw new IssueRefusal(
      `cannot make ${next} the coordinator of ${ref}: that session is another person's. A coordinator acts for the person whose session it is`,
    )
  }
  const holder = current !== null && current !== next ? sessions.get(current) : undefined
  if (holder && !holder.deletedAt && !holder.archived && holder.ownerUserId !== human) {
    throw new IssueRefusal(
      `cannot change the coordinator of ${ref}: another person's session holds it. Coordinate your own work through your own sub-task: \`podium issue create --parent-id ${ref} --title "…"\``,
    )
  }
}

/** The gate's warning on a start's result, which the CLI prints after it. */
function withWarning<T>(gate: { warning?: string }, result: T): T {
  if (!gate.warning || !result || typeof result !== 'object') return result
  return { ...result, warning: gate.warning }
}

/** Guardrail 2 [spec:SP-6144]: lifecycle moves on a proposed issue are
 *  operator-only, and the check FAILS CLOSED — an id that doesn't resolve is
 *  rejected too, so a bad ref (or a hub mirror the local get() can't see) can
 *  never dodge the lane. A person (any member, POD-6288) passes through untouched.
 *  `verb` completes "only an operator may <verb> a proposed issue". */
async function assertNotProposedForAgent(
  ctx: {
    reports: { get(id: string): Promise<{ stage: string } | null> }
    caller: IssueCaller
  },
  id: string,
  verb: string,
): Promise<void> {
  if (isPersonCapability(ctx.caller.capability)) return
  let stage: string | undefined
  try {
    stage = (await ctx.reports.get(id))?.stage
  } catch {
    stage = undefined
  }
  if (stage === undefined) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `unknown issue ${id}` })
  }
  if (stage === 'proposed') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `only an operator may ${verb} a proposed issue`,
    })
  }
}

/**
 * An agent's close is refused while a session on the issue is still working
 * [POD-5762]. Closing stops every session on the issue at once, so a close sent
 * mid-turn (an agent closing its own issue before it has finished) cuts that
 * turn off. The operator's close is not gated: the human decides.
 */
async function assertNoWorkingSessionsForAgentClose(
  ctx: IssueCommandCtx,
  id: string,
  confirmInterrupt: boolean | undefined,
): Promise<void> {
  if (isPersonCapability(ctx.caller.capability) || confirmInterrupt) return
  const issue = await ctx.reports.get(id)
  if (!issue) return
  const working = (
    await ctx.deps.listSessionsForIssue(issue.worktreePath ?? null, issue.id)
  ).filter((session) => isAgentComputing(session))
  if (working.length === 0) return
  const self = ctx.caller.capability.actorSessionId
  const ownIncluded = working.some((session) => session.sessionId === self)
  const names = working
    .map((session) =>
      session.sessionId === self ? 'your own session' : `"${session.name ?? session.title}"`,
    )
    .join(', ')
  throw new IssueRefusal(
    `close refused: ${working.length === 1 ? 'a session' : `${working.length} sessions`} on ` +
      `${await ctx.reports.niceRef(issue)} ${working.length === 1 ? 'is' : 'are'} still working ` +
      `(${names}). Closing stops every session on the issue at once, so that work is cut off ` +
      `mid-turn${ownIncluded ? ' — yours included, before this turn finishes' : ''}. ` +
      'Close your own issue only when the user has told you to; otherwise move it to `review` ' +
      'and post an offer with a Close action. To close anyway, re-run with `--confirm-interrupt`.',
  )
}

/**
 * A decision is closed only by the user (POD-6106, flight deck v6 D2): it is the
 * question the user owes an answer to, and an agent closing it would answer for
 * them. The guard also covers retyping a decision away, which would otherwise be
 * a two-step way around it. The operator (scope 'all') passes untouched.
 */
async function assertDecisionNotClosedByAgent(
  ctx: IssueCommandCtx,
  id: string,
  verb: string,
): Promise<void> {
  if (isPersonCapability(ctx.caller.capability)) return
  const issue = await ctx.reports.get(id)
  if (!issue || !isDecisionIssue(issue)) return
  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      `${verb} refused: ${await ctx.reports.niceRef(issue)} is a decision, and only the user ` +
      'closes a decision. Leave it open; ask your coordinator if you need the answer.',
  })
}

export type IssueCommandKind = 'query' | 'mutation'

/**
 * ONE JOINED ISSUE COMMAND: the handler half declared here, plus the two fields
 * `def()` merges in from the L1 contract so every derived surface keeps the shape
 * it already read.
 *
 * `target` is the old SCOPED_TARGET extractor: how to read the target EXISTING
 * issue id from the RAW, unparsed input. It stays on the server side because it
 * feeds the capability guard's subtree check ({@link guardIssueCommand}). It also
 * backed the retired viaHub forwarding detection; POD-309 deleted that consumer and
 * {@link commandTarget} survives for the guard alone.
 *
 * THE SEAM INVARIANT, which is asserted rather than assumed: an extractor is
 * present if and only if the contract declares `policy.resource === 'issue'`.
 * `registry.test.ts` checks the biconditional in both directions over the whole
 * table, so "this command has no existing target" and "somebody forgot the
 * extractor" cannot look alike. Note it is written over the PRESENCE of the
 * extractor and never over the value it returns: `mailClaim` deliberately returns
 * `undefined` from a present extractor, because its target is only discoverable by
 * loading the message, and its handler runs the same gate once it can.
 */
export interface IssueCommandDef<
  K extends IssueCommandKind = IssueCommandKind,
  In extends z.ZodTypeAny = z.ZodTypeAny,
  Out = unknown,
> {
  /** tRPC procedure type this command mounts as — a transport fact, not a
   *  contract one, which is why it did not move to L1. */
  kind: K
  /** Target EXISTING-issue id extractor (see interface doc). */
  target?: (input: Record<string, unknown>) => string | undefined
  /** The command body — calls one capability interface (the logic lives there). */
  handler: (ctx: IssueCommandCtx, input: z.infer<In>) => Out
  /** Merged from the contract by {@link def}: the ONE schema instance every
   *  transport parses with. Not re-declared here — see the module doc. */
  input: In
  /** Merged from the contract by {@link def}: `policy.action`. */
  action: CommandAction
  /** Merged from the contract by {@link def}: the ADR 1 conflict class. Present
   *  on EVERY def since POD-1250 made the field required on the contract base —
   *  a mutation carries one of the six real classes (the {@link
   *  ContractDeclaresConflict} constraint is what makes that total), and a query
   *  carries the written `'n/a'`. Declared here rather than only produced by
   *  `def` so a reader — a test, an audit — can ASK a def for its class instead
   *  of re-deriving it from the contract table. */
  conflict: ContractConflictClass
  /** Merged from the contract by {@link def}: the prose rule a `'cmd'` row must
   *  carry. Absent for every other class. */
  conflictRule?: string
}

/** The generics-erased wildcard shape (what heterogeneous collections of defs
 *  are typed as). Structural rather than `IssueCommandDef<…, any>` so zod's
 *  nominal-ish schema generics never fight assignability. */
export type AnyIssueCommandDef = {
  kind: IssueCommandKind
  input: z.ZodTypeAny
  action: CommandAction
  target?: (input: Record<string, unknown>) => string | undefined
  conflict: ContractConflictClass
  conflictRule?: string
  // biome-ignore lint/suspicious/noExplicitAny: the wildcard def erases per-command generics on purpose
  handler: (ctx: IssueCommandCtx, input: any) => any
}

/**
 * THE JOIN — the composition point POD-311's split names, and the only place a
 * contract meets a handler.
 *
 * It preserves the per-def generics (kind literal, contract input schema, handler
 * output) so the derived tRPC router keeps precise types, and it takes the
 * contract's `input` INSTANCE rather than a schema declared here. That is the
 * difference between a move and a re-specification: a restatement of the same
 * field list would parse identically, encode identically and pass every golden wire
 * fixture, so `registry.test.ts` asserts `toBe` against the contract instance for
 * all sixty-eight — object identity is the only instrument that sees the fork.
 */
/**
 * THE CONFLICT-CLASS TRIPWIRE [POD-1246].
 *
 * Every MUTATION's contract must declare an ADR 1 conflict class, and a `'cmd'`
 * row must also carry its rule. Expressed as a constraint on `def()` rather than
 * as a lint, because the point is ENUMERATION: with it, the compiler names every
 * command that is missing one; without it, applying ~43 declarations by hand is a
 * memory test that can be silently incomplete — which is the exact failure this
 * work exists to end.
 *
 * STILL SCOPED TO THE ISSUE TABLE, and still needed after POD-1250 made
 * `conflict` required on `CommandContractBase` fleet-wide. That change makes
 * every contract ANSWER; it cannot make a mutation answer with one of the six
 * REAL classes, because nothing on the shared base knows which commands mutate.
 * `'n/a'` satisfies the base and is rejected here — which is precisely the
 * mutation-specific half this constraint exists to enforce.
 */
type ContractDeclaresConflict<C> = C extends { readonly conflict: 'cmd' }
  ? C extends { readonly conflictRule: string }
    ? unknown
    : { readonly __cmdRowMustCarryAConflictRule: never }
  : C extends { readonly conflict: ConflictClass }
    ? unknown
    : { readonly __mutationContractMustDeclareARealConflictClassNotNA: never }

function def<N extends IssueContractName, K extends IssueCommandKind, Out>(
  name: N,
  d: {
    kind: K
    target?: (input: Record<string, unknown>) => string | undefined
    handler: (ctx: IssueCommandCtx, input: ContractInput<(typeof ISSUE_CONTRACTS)[N]>) => Out
  } & (K extends 'mutation' ? ContractDeclaresConflict<(typeof ISSUE_CONTRACTS)[N]> : unknown),
): IssueCommandDef<
  K,
  (typeof ISSUE_CONTRACTS)[N]['input'],
  Promise<K extends 'mutation' ? IssueCommandResult<Awaited<Out>> : Awaited<Out>>
> {
  const contract = ISSUE_CONTRACTS[name]
  return {
    ...d,
    handler: async (ctx: IssueCommandCtx, input: ContractInput<(typeof ISSUE_CONTRACTS)[N]>) => {
      // A query is one operation: one read scope, so the per-row `mayRead`
      // checks share one batched grant read (POD-6149, server-data rule 2).
      if (d.kind === 'query') return await withReadScope(async () => await d.handler(ctx, input))
      const result = await d.handler(ctx, input)
      return d.kind === 'mutation'
        ? await ctx.reports.commandResult(result, ctx.markerUser())
        : result
    },
    input: contract.input,
    action: contract.policy.action,
    // Every contract declares a class since POD-1250, so this is an
    // unconditional read — a query's is `'n/a'`. The `conflictRule` below stays
    // conditional because it belongs to `cmd` rows alone.
    conflict: contract.conflict,
    ...('conflictRule' in contract ? { conflictRule: contract.conflictRule } : {}),
  } as unknown as IssueCommandDef<
    K,
    (typeof ISSUE_CONTRACTS)[N]['input'],
    Promise<K extends 'mutation' ? IssueCommandResult<Awaited<Out>> : Awaited<Out>>
  >
}

async function shippingOrderResult<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ShippingOrderAccessError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: error.message })
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// The target extractor the shipped table used on every `id`-keyed command. The
// input SCHEMAS it used to sit beside now live on the contracts.
// ---------------------------------------------------------------------------

const targetId = (i: Record<string, unknown>) => i.id as string | undefined

// ---------------------------------------------------------------------------
// The table. Grouped as the old service was: reads, writes, agent mail,
// event subscriptions. `satisfies` pins the keys to the protocol name list.
// ---------------------------------------------------------------------------

const defs = {
  // ---- reads (action 'read': never scope-gated, viewers allowed) ----

  list: def('list', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.list(
        input.repoPath,
        ctx.issueReader(),
        await assigneeScope(ctx, input.assignee, 'all'),
      ),
  }),
  prime: def('prime', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.prime(
        {
          repoPath: input?.repoPath,
          boundIssueId:
            ctx.caller.capability.scope.kind === 'subtree'
              ? ctx.caller.capability.scope.rootId
              : null,
          // Who is who on a shared instance (POD-6296), all server-stamped.
          ...(ctx.markerUser() ? { human: ctx.markerUser()! } : {}),
          ...(isPersonCapability(ctx.caller.capability) ? {} : { scope: await agentScopeRef(ctx) }),
          assignee: await assigneeScope(ctx, input?.assignee, 'me'),
          // Per-reader mail count [POD-1379]; server-stamped, never from input.
          ...(ctx.caller.capability.actorSessionId
            ? { sessionId: ctx.caller.capability.actorSessionId }
            : {}),
        },
        ctx.issueReader(),
      ),
  }),
  ready: def('ready', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.readyList(
        input.repoPath,
        ctx.issueReader(),
        await assigneeScope(ctx, input.assignee, 'me'),
      ),
  }),
  blocked: def('blocked', {
    kind: 'query',
    handler: async (ctx, input) => await ctx.reports.blockedList(input.repoPath, ctx.issueReader()),
  }),
  graph: def('graph', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.visibleGraph(await ctx.reports.graph(input.repoPath, ctx.issueReader())),
  }),
  epicStatus: def('epicStatus', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.readIssue(
        input.id,
        async () => await ctx.reports.epicStatus(input.id, ctx.issueReader()),
      ),
  }),
  children: def('children', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.readIssue(
        input.id,
        async () =>
          await ctx.reports.children(input.id, input.recursive ?? false, ctx.issueReader()),
      ),
  }),
  tree: def('tree', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.tree(
        input.id,
        {
          ...(input.maxDepth != null ? { maxDepth: input.maxDepth } : {}),
          ...(input.maxNodes != null ? { maxNodes: input.maxNodes } : {}),
          assignee: await assigneeScope(ctx, input.assignee, 'all'),
        },
        ctx.issueReader(),
      ),
  }),
  deck: def('deck', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.deck(
        input.id,
        ctx.issueReader(),
        await assigneeScope(ctx, input.assignee, 'all'),
      ),
  }),
  depReport: def('depReport', {
    kind: 'query',
    handler: async (ctx, input) => await ctx.reports.depReport(input, ctx.issueReader()),
  }),
  closeEligibleEpics: def('closeEligibleEpics', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.closeEligibleEpics(input.repoPath, ctx.issueReader()),
  }),
  labelList: def('labelList', {
    kind: 'query',
    handler: async (ctx) => await ctx.reports.labelList(),
  }),
  findDuplicates: def('findDuplicates', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.findDuplicates(input.repoPath, input.threshold, ctx.issueReader()),
  }),
  stale: def('stale', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.staleList(input.repoPath, input.days, Date.now(), ctx.issueReader()),
  }),
  doctor: def('doctor', {
    kind: 'query',
    handler: async (ctx, input) => await ctx.reports.doctor(input.repoPath, ctx.issueReader()),
  }),
  preflight: def('preflight', {
    kind: 'query',
    handler: async (ctx, input) => await ctx.reports.preflight(input.repoPath, ctx.issueReader()),
  }),
  deliveryReceipt: def('deliveryReceipt', {
    kind: 'query',
    // Shipping resolves order -> root and authorizes before revealing whether a
    // receipt exists. Collapse inaccessible/absent orders at this command edge.
    handler: async (ctx, input) =>
      await shippingOrderResult(
        async () =>
          await ctx.shipping.deliveryReceipt({
            orderId: input.orderId,
            principal: ctx.requirePrincipal(),
          }),
      ),
  }),
  search: def('search', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.search(await assigneeFiltered(ctx, input), ctx.issueReader()),
  }),
  searchNormalized: def('searchNormalized', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.reports.searchNormalized(await assigneeFiltered(ctx, input), ctx.issueReader()),
  }),
  count: def('count', {
    kind: 'query',
    handler: async (ctx, input) => await ctx.reports.count(input.repoPath, ctx.issueReader()),
  }),
  stats: def('stats', {
    kind: 'query',
    handler: async (ctx, input) => await ctx.reports.stats(input.repoPath, ctx.issueReader()),
  }),
  orphans: def('orphans', {
    kind: 'query',
    handler: async (ctx, input) => await ctx.reports.orphans(input.repoPath, ctx.issueReader()),
  }),
  get: def('get', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.readIssue(input.id, async () => {
        // The reader's own markers ride the report (POD-6288).
        const issue = await ctx.reports.get(input.id, ctx.issueReader())
        if (!issue) return null
        // The issue's live sessions ride the read (ab75ab1e). `shell` panes are
        // not agents on the issue, so they are not listed as such.
        // Only the sessions this reader may read (POD-6285): sessions are private.
        const reader = ctx.issueReader().viewer() ?? undefined
        const sessions = (
          await ctx.deps.listSessionsForIssue(issue.worktreePath, issue.id, reader)
        ).filter((session) => session.agentKind !== 'shell')
        return {
          ...issue,
          sessions,
          sessionSummaries: await sessionSummaries(ctx, issue),
          allowed: await allowedActions(ctx, issue.id),
        }
      }),
  }),
  resolveRefs: def('resolveRefs', {
    kind: 'query',
    handler: async (ctx, input) =>
      await Promise.all(
        (await ctx.reports.resolveRefs(input.refs)).map(async ({ ref, id }) => {
          try {
            // Missing and unreadable references have exactly the same answer.
            return { ref, id: id !== null && (await ctx.mayReadIssue(id)) ? id : null }
          } catch {
            return { ref, id: null }
          }
        }),
      ),
  }),
  /** Read one artifact's stored bytes back (POD-1999). A read of issue content,
   *  so it rides `readIssue` like `get` — and it is served from the server's own
   *  snapshot dir, so it answers with the authoring machine offline. */
  artifactRead: def('artifactRead', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.readIssue(
        input.id,
        async () =>
          await ctx.crud.panelArtifactRead(input.id, {
            ...(input.index != null ? { index: input.index } : {}),
            ...(input.path != null ? { path: input.path } : {}),
            ...(input.file != null ? { file: input.file } : {}),
          }),
      ),
  }),
  /** Lazy comment fetch (#175) — bodies left IssueProjection (commentCount rides it).
   *  A read (like get/list). Hub-mirrored issues have no local thread: their
   *  comments live on the hub, so this returns []. */
  comments: def('comments', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.readIssue(input.id, async () => {
        // Each comment says whether it is the reader's own (POD-6295): the
        // page offers edit on those only.
        const principal = ctx.caller.principal
        return (await ctx.commentsMail.comments(input.id)).map((comment) => ({
          ...comment,
          mayEdit: principal ? isCommentAuthor(comment.authorId, principal) : false,
        }))
      }),
  }),
  events: def('events', {
    kind: 'query',
    handler: async (ctx, input) => {
      const events = await ctx.reports.listEvents(input.since, {
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.excludeKinds ? { excludeKinds: input.excludeKinds } : {}),
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.limit != null ? { limit: input.limit } : {}),
        ...(input.before != null ? { before: input.before } : {}),
        ...(input.order ? { order: input.order } : {}),
      })
      // The log holds every member's history (POD-6291): a person, or an agent
      // for one, reads only what is theirs to see. See `event-visibility.ts`.
      const member = ctx.markerUser()
      if (member === undefined) return events
      const visibleMail = ctx.deps.mailVisibleIds
      return await eventsForMember(events, member, {
        ...ctx.deps.executionFacts,
        ...(visibleMail
          ? {
              visibleMessageIds: async (ids: readonly string[]) =>
                await visibleMail(ctx.caller.capability, ids),
            }
          : {}),
      })
    },
  }),
  // hits the external Linear API — 'write' keeps read-only callers from driving it
  linearSearch: def('linearSearch', {
    kind: 'query',
    handler: async (ctx, input) => await ctx.gitWorkflow.linearSearch(input.query),
  }),

  // ---- writes (scope-gated on their existing target via `target`) ----

  // agent-posted current state (activityNotes) — same nature as panelApply
  setState: def('setState', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await ctx.crud.setState(input.id, input.text),
  }),
  // agent-published human panel (todos/artifacts/deferred) — part of doing the work
  panelApply: def('panelApply', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      // Artifact ops route through the permanent-store paths ([spec:SP-0fc9]):
      // add pulls a snapshot from the owning daemon before the panel commit;
      // remove also deletes the snapshot dir.
      if (input.op === 'artifact-upload') {
        if (!input.upload) throw new IssueRefusal('artifact-upload requires an upload packet')
        return await ctx.crud.panelArtifactTransfer(input.id, input.upload)
      }
      if (input.op === 'artifact-add') {
        if (!input.path) throw new IssueRefusal('artifact-add requires a path')
        return await ctx.crud.panelArtifactAdd(
          input.id,
          {
            path: input.path,
            ...(input.title ? { title: input.title } : {}),
            ...(input.extraPaths ? { extraPaths: input.extraPaths } : {}),
            ...(input.terminalEvidence ? { terminalEvidence: true } : {}),
            ...(input.sourceRoot ? { sourceRoot: input.sourceRoot } : {}),
          },
          ctx.caller.capability.actorSessionId
            ? { actorSessionId: ctx.caller.capability.actorSessionId }
            : undefined,
        )
      }
      if (input.op === 'artifact-remove') {
        if (input.index == null) throw new IssueRefusal('artifact-remove requires an index')
        return await ctx.crud.panelArtifactRemove(input.id, input.index)
      }
      return await ctx.crud.panelApply(input.id, {
        op: input.op,
        text: input.text,
        index: input.index,
        path: input.path,
        title: input.title,
      } as never)
    },
  }),
  // write — filing/decomposing is additive; scope gates writes to EXISTING issues,
  // not creation (no `target`).
  create: def('create', {
    kind: 'mutation',
    handler: async (ctx, input) => {
      // #198 [spec:SP-a859]: two provenance axes, both derived HERE so they can't be forged.
      //  - origin  = WHO CREATED it: the unconstrained operator (scope 'all', i.e.
      //    the web UI / human) → 'human'; any constrained agent → 'agent'.
      //  - audience = WHO IT IS FOR: operator creates are always human-facing; an
      //    agent's creates default to 'agent' (internal working detail) and are
      //    opted onto the board only when the agent passes audience: 'human'.
      //
      // Top-level agent discoveries are human-facing proposals. Stage, audience,
      // and start behavior are forced at this authenticated boundary. [spec:SP-6144]
      const isOperator = isPersonCapability(ctx.caller.capability)
      const origin: 'human' | 'agent' = isOperator ? 'human' : 'agent'
      // B3 [spec:SP-6144]: a parentId is validated BEFORE anything persists.
      // Previously the row was persisted+broadcast first and reparent threw
      // after, leaving an orphan behind on a bogus parent — and an agent could
      // dodge the top-level/proposed rule by naming ANY existing issue (even a
      // closed or archived one) as parent. Top-levelness is decided only
      // against a real, agent-reachable parent.
      let parent: Awaited<ReturnType<typeof ctx.reports.get>> = null
      if (input.parentId) {
        try {
          parent = await ctx.reports.get(input.parentId)
        } catch {
          parent = null
        }
        if (!parent) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `unknown parent issue ${input.parentId} — nothing was created`,
          })
        }
        const parentClosed = parent.stage === 'done' || parent.closedReason != null
        if (!isOperator && (parent.archived || parentClosed)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `parent ${input.parentId} is ${parent.archived ? 'archived' : 'closed'} — a sub-issue needs an open parent`,
          })
        }
      }
      // POD-6106 (D3): an agent applies only labels that exist unless it passes
      // createLabels. Checked before anything persists, like the parent above.
      await ctx.crud.refuseUnknownLabels(input.labels, isOperator || input.createLabels === true)
      // M5 [spec:SP-6144]: sub-creates under a proposed parent (or deeper in a
      // proposal subtree) stay inert — never auto-started, never board-facing.
      const underProposed =
        parent != null && !isOperator && (await ctx.hierarchy.inProposedSubtree(parent.id))
      const isAgentTopLevel = origin === 'agent' && !input.parentId
      const audience: 'human' | 'agent' = isOperator
        ? 'human'
        : isAgentTopLevel
          ? 'human'
          : underProposed
            ? 'agent'
            : (input.audience ?? 'agent')
      // The orphan-internal guard is computed INSIDE withMutation so it is cached
      // with the result: a replayed create (same mutationId) returns the identical
      // payload even if the tree changed in between. An audience:'agent' issue is
      // visible only when its parent chain reaches an audience:'human' ancestor
      // (filterBoardScope). With none it is invisible — warn (don't block) so an
      // unattached agent doesn't silently lose the issue.
      // Agent top-level creates never hit that path: audience is forced human above.
      return await ctx.withMutation(input.mutationId, async () => {
        // Started-by provenance (M6 deliverable 3): bare session id of the creating
        // agent. Operator (scope 'all') creates stay null — no inventing a session.
        const startedBySession =
          !isOperator && ctx.caller.capability.actorSessionId
            ? ctx.caller.capability.actorSessionId
            : null
        const attribution = attributionOf(ctx.requirePrincipal())
        if (!attribution.onBehalfOf)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'issue creation requires an accountable human owner',
          })
        // THE ASSIGNEE OF A NEW TASK (POD-6287): the creating human, or for an
        // agent its delegating human. A person may name another member; an
        // agent naming anyone but its own human is refused like a reassignment.
        const { assignee, ...fields } = input
        const named =
          assignee === undefined ||
          (personHuman(ctx) === undefined &&
            (assignee.trim() === 'me' || assignee.trim() === attribution.onBehalfOf))
            ? attribution.onBehalfOf
            : await assigneeNamed(ctx, assignee)
        const created = await ctx.gitWorkflow.createAndMaybeStart(
          {
            ...fields,
            origin,
            audience,
            startedBySession,
            ownerUserId: named,
            visibility: 'personal' as const,
            createdByActor: attribution.actor,
            createdByOnBehalfOf: attribution.onBehalfOf,
            ...(isAgentTopLevel ? { stage: 'proposed' as const, startNow: false } : {}),
            ...(underProposed ? { startNow: false } : {}),
          },
          { spawnedBy: ctx.spawnProvenance() },
        )
        // D3 (POD-6108): the first child a session creates under its own issue
        // makes it that issue's coordinator — announced here, where it happened.
        const actor = ctx.caller.capability.actorSessionId
        const after =
          parent != null && actor != null && !parent.coordinatorSessionId
            ? await ctx.reports.get(parent.id)
            : null
        const announced: { coordinator?: string } =
          after && actor && after.coordinatorSessionId === actor
            ? { coordinator: becameCoordinatorText(await ctx.reports.niceRef(after)) }
            : {}
        if (audience === 'agent' && !(await ctx.hasHumanAudienceAncestor(created))) {
          return {
            ...created,
            ...announced,
            warning:
              'This issue is invisible: it is internal (audience: agent) but has no ' +
              'human-facing parent. Pass `--audience human`, or attach to an issue first ' +
              'so it nests under a tracked parent.',
          }
        }
        return { ...created, ...announced }
      })
    },
  }),
  start: def('start', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      // M5 [spec:SP-6144]: the whole proposal SUBTREE is inert — a sub-issue
      // filed under a proposed parent cannot be started to run work under an
      // unapproved proposal, so the ancestor chain is checked, not just the row.
      await assertNotProposedForAgent(ctx, input.id, 'start')
      if (!isPersonCapability(ctx.caller.capability)) {
        for (const anc of await ctx.hierarchy.ancestorIds(input.id)) {
          await assertNotProposedForAgent(ctx, anc, 'start work under')
        }
      }
      const gate = await workMachineGate(ctx, input.id, 'start')
      return await ctx.withMutation(input.mutationId, async () =>
        withWarning(
          gate,
          await ctx.gitWorkflow.start(input.id, input.agentKind, {
            spawnedBy: ctx.spawnProvenance(),
            ...startedOnBehalfOf(ctx),
            // Explicit per-launch choice (POD-1545); persists onto the issue profile.
            ...(input.defaultModel ? { model: input.defaultModel } : {}),
            ...(input.defaultEffort ? { effort: input.defaultEffort } : {}),
            ...(input.agentProfile ? { agentProfile: input.agentProfile } : {}),
            ...(input.forceUnknownModel ? { forceUnknownModel: true } : {}),
          }),
        ),
      )
    },
  }),
  update: def('update', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.patch.assignee !== undefined
          ? memberMutationId(ctx, input.mutationId)
          : input.mutationId,
        async () => {
          // B1/B2 [spec:SP-6144]: the update patch can move an issue out of the
          // lane through MORE than `stage` — archived (dismissal), closedReason
          // (close), parentId (no longer top-level). All of them are lifecycle
          // moves and all take the same operator-only guard.
          const p = input.patch
          const movesLifecycle =
            (p.stage != null && p.stage !== 'proposed') ||
            p.archived !== undefined ||
            p.closedReason !== undefined ||
            p.parentId !== undefined
          if (movesLifecycle) await assertNotProposedForAgent(ctx, input.id, 'promote')
          if (p.stage === 'done' || p.closedReason !== undefined) {
            await assertDecisionNotClosedByAgent(ctx, input.id, 'close')
            await assertNoWorkingSessionsForAgentClose(ctx, input.id, input.confirmInterrupt)
          }
          if (p.type !== undefined && p.type !== 'decision') {
            await assertDecisionNotClosedByAgent(ctx, input.id, 'retype')
          }
          // `assignee` is a REASSIGNMENT, not a free-text field (POD-6287): it
          // moves the owner, with the reassignment's rules.
          const { assignee, ...patch } = p
          const owner = assignee === undefined ? undefined : await assigneeNamed(ctx, assignee)
          const viewer = ctx.markerUser()
          return await ctx.crud.update(input.id, patch, {
            actorSessionId: ctx.caller.capability.actorSessionId,
            ...(viewer ? { viewer, caller: viewer } : {}),
            ...(owner ? { owner } : {}),
            ...textAttribution(ctx),
          })
        },
      ),
  }),
  // A task's description or brief history (POD-6289): read like the task.
  textRevisions: def('textRevisions', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.readIssue(
        input.id,
        async () => await ctx.crud.textRevisions(input.id, input.field),
      ),
  }),
  // Restoring is an edit like any other (POD-6289): anyone who may edit the
  // task may, under its revision, and it appends a revision of its own.
  restoreTextRevision: def('restoreTextRevision', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) =>
      await ctx.withMutation(input.mutationId, async () => {
        const viewer = ctx.markerUser()
        return await ctx.crud.restoreTextRevision(input.id, input.revisionId, {
          actorSessionId: ctx.caller.capability.actorSessionId,
          ...(viewer ? { viewer, caller: viewer } : {}),
          ...textAttribution(ctx),
        })
      }),
  }),
  promote: def('promote', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      if (!isPersonCapability(ctx.caller.capability)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'only an operator may promote a proposed issue',
        })
      }
      // POD-6119: the stage check runs INSIDE the ledger, so a retried promote
      // (same mutationId) gets its receipt instead of "issue is not proposed".
      return await ctx.withMutation(input.mutationId, async () => {
        const issue = await ctx.reports.get(input.id)
        if (!issue) throw new TRPCError({ code: 'NOT_FOUND', message: `unknown issue ${input.id}` })
        if (issue.stage !== 'proposed') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'issue is not proposed' })
        }
        return await ctx.crud.update(input.id, { stage: 'backlog' })
      })
    },
  }),
  // Agent self-organization (issue-as-workspace): re-home the calling session
  // onto an existing issue or a fresh sub-issue. sessionId comes from the daemon
  // relay context (the relay gate overwrites it) — never trusted from agent input.
  // Write, DELIBERATELY NOT scope-gated (no `target`): attaching is the session
  // RE-HOMING itself onto another issue — targeting outside the current subtree
  // is the whole point, so no --outside-scope needed. Not hub-forwarded
  // (sessions are local).
  attachSession: def('attachSession', {
    kind: 'mutation',
    handler: async (ctx, input) => {
      const origin: 'human' | 'agent' = isPersonCapability(ctx.caller.capability)
        ? 'human'
        : 'agent'
      // B2/M5 [spec:SP-6144]: a session may not re-home onto (or file a
      // sub-issue under) a proposed issue — the proposal subtree is inert.
      if (input.targetId != null) {
        await assertNotProposedForAgent(ctx, input.targetId, 'attach a session to')
      }
      const { newSubissue, newSpinoff, ...rest } = input
      return await ctx.deps.attachSession(ctx.caller, {
        ...rest,
        ...(newSubissue ? { newSubissue: { title: newSubissue.title, origin } } : {}),
        ...(newSpinoff ? { newSpinoff: { title: newSpinoff.title, origin } } : {}),
      })
    },
  }),
  archive: def('archive', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation
    // elsewhere. Archiving is reversible and no more destructive than close.
    target: targetId,
    handler: async (ctx, input) => {
      await assertNotProposedForAgent(ctx, input.id, 'archive')
      // The scope guard stays OUTSIDE the ledger, like `update`'s does: a
      // replayed archive must not be waved through on a cached receipt minted
      // when the subtree looked different (D8 re-authorizes at every apply).
      return await ctx.withMutation(
        input.mutationId,
        async () => await ctx.attention.archive(input.id),
      )
    },
  }),
  delete: def('delete', {
    kind: 'mutation',
    target: targetId,
    // POD-781: outboxed, so a replayed drain must not tombstone twice. The
    // cascade behind this call deletes every member session as well, which is
    // exactly why the receipt matters — a second pass would re-stamp tombstones
    // over rows the operator may have restored in between.
    handler: (ctx, input) => ctx.withMutation(input.mutationId, () => ctx.deleteIssue(input.id)),
  }),
  restore: def('restore', {
    kind: 'mutation',
    target: targetId,
    // POD-781: outboxed, and the inverse of `delete` needs the receipt for the
    // inverse reason. Restoring a live issue is already a no-op, so the hazard
    // is not a double apply but a LATE one — a re-sent restore arriving after a
    // second delete would un-tombstone the issue and every session that delete
    // took with it.
    handler: (ctx, input) => ctx.withMutation(input.mutationId, () => ctx.restoreIssue(input.id)),
  }),
  action: def('action', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await ctx.gitWorkflow.action(input.id, input.kind),
  }),
  // Write, not manage: heavily guarded (closed + merged + clean only), so a
  // closing agent may clean up after itself. Acts on LOCAL git state — it removes a
  // worktree directory and deletes a branch via THIS machine's daemon.
  cleanup: def('cleanup', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await ctx.gitWorkflow.cleanup(input.id, ctx.requirePrincipal()),
  }),
  // Stop every session on the issue and free the worktree, keeping the branch
  // [spec:SP-9904]. Scope-gated like other issue writes (self/subtree free;
  // outside needs --outside-scope). Acts on THIS machine's sessions and worktree.
  stop: def('stop', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      if (!ctx.deps.stopIssueSessions) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'stopIssueSessions is not wired',
        })
      }
      // Stopping a task stops the CALLER's sessions on it, nobody else's
      // (POD-6287, MU-24): a person's own, or for an agent its human's.
      const ownedBy = ctx.markerUser()
      const r = await ctx.deps.stopIssueSessions({
        issueId: input.id,
        principal: ctx.requirePrincipal(),
        ...(ownedBy ? { ownedBy } : {}),
        ...(input.force ? { force: true } : {}),
        ...(ctx.caller.capability.actorSessionId
          ? { callerSessionId: ctx.caller.capability.actorSessionId }
          : {}),
      })
      if (!r.ok) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: r.reason ?? 'stop refused',
        })
      }
      return r
    },
  }),
  // Write, not manage: builds/resets a dedicated integration worktree+branch only —
  // never touches child branches, the root checkout, or the parent branch. Spawns
  // nothing, so no confirm gate beyond the write role gate. Like cleanup, it rebuilds
  // a LOCAL integration worktree/branch via THIS machine's daemon.
  integrate: def('integrate', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) =>
      await ctx.gitWorkflow.integrate(input.id, ctx.requirePrincipal()),
  }),
  ship: def('ship', {
    kind: 'mutation',
    // Optional by design. An explicit raw id is guarded before parsing; an
    // omission is resolved only from the authenticated subtree in the handler.
    target: targetId,
    handler: async (ctx, input) =>
      await ctx.shipping.enqueueCurrent({
        issueId: await ctx.shipIssue(input.id),
        principal: ctx.requirePrincipal(),
        overrideScope: ctx.caller.overrideScope === true,
      }),
  }),
  cancelShip: def('cancelShip', {
    kind: 'mutation',
    // The input names an ORDER. Shipping resolves order -> delivery root before
    // authorization and owns every durable generation/custody fence.
    target: () => undefined,
    handler: async (ctx, input) =>
      await shippingOrderResult(
        async () =>
          await ctx.shipping.cancel({
            orderId: input.orderId,
            principal: ctx.requirePrincipal(),
            overrideScope: ctx.caller.overrideScope === true,
          }),
      ),
  }),
  resolveShipHold: def('resolveShipHold', {
    kind: 'mutation',
    // The input names an ORDER. The Shipping service loads order -> root issue
    // and runs the same live issue authorization there.
    target: () => undefined,
    handler: async (ctx, input) =>
      await shippingOrderResult(
        async () =>
          await ctx.shipping.resolveHold({
            orderId: input.orderId,
            action: input.action,
            expectedGeneration: input.expectedGeneration,
            principal: ctx.requirePrincipal(),
            overrideScope: ctx.caller.overrideScope === true,
          }),
      ),
  }),
  addSession: def('addSession', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      const gate = await workMachineGate(ctx, input.id, 'add a session to')
      return withWarning(
        gate,
        await ctx.gitWorkflow.addSession(input.id, input.agentKind, {
          spawnedBy: ctx.spawnProvenance(),
          ...startedOnBehalfOf(ctx),
          ...(input.forceUnknownModel ? { forceUnknownModel: true } : {}),
        }),
      )
    },
  }),
  addShell: def('addShell', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      const gate = await workMachineGate(ctx, input.id, 'add a shell to')
      return withWarning(
        gate,
        await ctx.gitWorkflow.addShell(input.id, {
          spawnedBy: ctx.spawnProvenance(),
          ...startedOnBehalfOf(ctx),
        }),
      )
    },
  }),
  applySuggestion: def('applySuggestion', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await ctx.crud.applySuggestion(input.id),
  }),
  dismissSuggestion: def('dismissSuggestion', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await ctx.crud.dismissSuggestion(input.id),
  }),
  refreshAssistant: def('refreshAssistant', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await ctx.gitWorkflow.refreshAssistant(input.id),
  }),
  setLabels: def('setLabels', {
    kind: 'mutation',
    target: targetId,
    // POD-781: outboxed. The receipt matters even for a whole-set write, because
    // the SET is computed on the client from the labels it could see — a replay
    // that re-ran it would push a stale set over one edited in between.
    handler: async (ctx, input) => {
      // POD-6106 (D3): an agent applies only existing labels unless it passes
      // createLabels; the operator creates-or-picks.
      await ctx.crud.refuseUnknownLabels(
        input.labels,
        isPersonCapability(ctx.caller.capability) || input.createLabels === true,
      )
      return await ctx.withMutation(
        input.mutationId,
        async () => await ctx.crud.setLabels(input.id, input.labels),
      )
    },
  }),
  // Tasks are visible to all members (design §2.2, §4.1, POD-6288): there is
  // no per-task grant to write or remove, and existing issue grants are inert
  // history. Both commands answer that, after the usual checks, and write
  // nothing.
  share: def('share', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await refuseTaskSharing(ctx, input.id),
  }),
  unshare: def('unshare', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await refuseTaskSharing(ctx, input.id),
  }),
  addComment: def('addComment', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () =>
          await ctx.commentsMail.addCallerComment(input.id, input.body, ctx.requirePrincipal()),
      ),
  }),
  // Only a comment's author edits or deletes it; an admin may moderate,
  // audited, and the comment keeps its author (POD-6289).
  editComment: def('editComment', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () =>
          await ctx.commentsMail.editComment(
            input.id,
            input.commentId,
            input.body,
            ctx.requirePrincipal(),
          ),
      ),
  }),
  deleteComment: def('deleteComment', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () =>
          await ctx.commentsMail.deleteComment(input.id, input.commentId, ctx.requirePrincipal()),
      ),
  }),
  depAdd: def('depAdd', {
    kind: 'mutation',
    target: (i) => i.fromId as string,
    handler: async (ctx, input) => await ctx.hierarchy.addDep(input.fromId, input.toId, input.type),
  }),
  depRemove: def('depRemove', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // Removing a mistaken edge is the inverse of the already-agent-safe depAdd.
    target: (i) => i.fromId as string,
    handler: async (ctx, input) =>
      await ctx.hierarchy.removeDep(input.fromId, input.toId, input.type),
  }),
  defer: def('defer', {
    kind: 'mutation',
    target: targetId,
    // POD-781: outboxed, so a replayed drain must not re-defer. Absolute-set, so
    // a second identical apply is harmless — but a LATE one is not: the ledger is
    // what stops a drain landing a snooze the operator has since ended.
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () => await ctx.attention.defer(input.id, input.until),
      ),
  }),
  // Manual unsnooze (issue #133): ends a snooze and floats the issue back to the
  // top of WORK with the "Unsnoozed" tag (returned-from-defer), unlike defer(null)
  // which quietly clears it. Distinct route so it emits issue.unsnoozed cleanly.
  undefer: def('undefer', {
    kind: 'mutation',
    target: targetId,
    // POD-781: outboxed, and this one is NOT idempotent on its own — it backdates
    // `deferUntil` against the clock at apply time, so a re-sent drain would move
    // the "Unsnoozed" marker forward and re-emit `issue.unsnoozed`.
    handler: async (ctx, input) =>
      await ctx.withMutation(input.mutationId, async () => await ctx.attention.undefer(input.id)),
  }),
  // Mark an issue read (issue #124): stamp read_at = now, flipping derived `unread`.
  // Read-tracking carries 'read' authority only (reading marks read), despite being
  // a mutation on the wire.
  markRead: def('markRead', {
    kind: 'mutation',
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () => await ctx.attention.markIssueRead(input.id, input.readAt, ctx.markerUser()),
      ),
  }),
  // Mark an issue UNREAD again (issue #138): clear read_at, flipping derived
  // `unread` back to true. Like markRead, read-tracking needs only 'read'.
  markUnread: def('markUnread', {
    kind: 'mutation',
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () => await ctx.attention.markIssueUnread(input.id, ctx.markerUser()),
      ),
  }),
  // Tuck a finished issue into the sidebar's Closed fold, or bring it back
  // (POD-333). Sidebar curation the operator performs while reading the board —
  // 'read' authority like markRead, despite being a mutation on the wire.
  setTucked: def('setTucked', {
    kind: 'mutation',
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () => await ctx.attention.setIssueTucked(input.id, input.tucked, ctx.markerUser()),
      ),
  }),
  // PERSONAL RECORDS (POD-6290): join a task you can read. It enters your own
  // sidebar set and you become a collaborator; nothing else changes and no
  // access follows. An agent joining records its human's, as the agent's.
  join: def('join', {
    kind: 'mutation',
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () =>
          await ctx.readIssue(
            input.id,
            async () =>
              await ctx.attention.joinIssue(
                input.id,
                ctx.requireMarkerUser(),
                ctx.caller.principal?.kind === 'agent' ? 'agent' : 'join',
              ),
          ),
      ),
  }),
  // Remove your own "assigned to you by X" row (POD-6290). The task stays
  // assigned to you, and your start or join record, if any, stays.
  dismissAssignment: def('dismissAssignment', {
    kind: 'mutation',
    handler: async (ctx, input) =>
      await ctx.withMutation(
        input.mutationId,
        async () => await ctx.attention.dismissAssignment(input.id, ctx.requireMarkerUser()),
      ),
  }),
  // A task's collaborators (POD-6290): read like the task.
  collaborators: def('collaborators', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.readIssue(input.id, async () => await ctx.attention.collaborators(input.id)),
  }),
  setNeedsHuman: def('setNeedsHuman', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      // askedBy is SERVER-AUTHORITATIVE (#53 review): issues.answerQuestion later
      // delivers the human's answer INTO the stored askedBy session, so letting a
      // constrained caller point it at an arbitrary live session would turn the
      // human's chip click into an injected message there (confused deputy —
      // attachSession can re-home any session, so even a "same issue" allowance
      // is launderable). A constrained caller may attribute the question only to
      // ITSELF: explicit askedBy must equal its authenticated actorSessionId.
      // The unconstrained operator (human web/CLI, trusted in-process MCP, and
      // hub-side execution of node-forwarded mutations, which authenticate as
      // the operator) stays free to attribute — it IS the principal this deputy
      // check protects, and the forwarded-node path depends on it.
      const actor = ctx.caller.capability.actorSessionId
      const askedBy = input.askedBy ?? actor
      if (askedBy && !isPersonCapability(ctx.caller.capability) && askedBy !== actor) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'askedBy is server-authoritative: agents may only attribute a question to their own session (omit askedBy)',
        })
      }
      const principal = ctx.requirePrincipal()
      const attribution =
        principal.kind === 'user'
          ? { actor: actorUser(principal.user), onBehalfOf: principal.user }
          : principal.kind === 'agent'
            ? {
                actor: actorAgent(asAgentIdentityId(principal.agentSessionId)),
                onBehalfOf: principal.onBehalfOf,
              }
            : { actor: actorSystem(principal.job), onBehalfOf: null }
      return await ctx.attention.setNeedsHuman(input.id, input.question ?? null, {
        ...(input.options ? { options: input.options } : {}),
        ...(askedBy ? { askedBy } : {}),
        attribution,
      })
    },
  }),
  /** Web-callable Tray answer (issue #53): deliver `answer` to the asking
   *  session via the shared answer_question matching path (live native menu →
   *  option digits; otherwise a chat message through the durable resumeAndSend),
   *  then clear needsHuman — ONLY after successful delivery, so a failed match
   *  or dead session never silently drops the question. */
  answerQuestion: def('answerQuestion', {
    kind: 'mutation',
    // No task target (POD-6283): the gate is the ASKING session's owner, decided
    // by `answerSessionQuestion` before anything is typed into it.
    handler: async (ctx, input) => {
      const issue = await ctx.reports.getMeta(input.id)
      if (!issue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `unknown issue ${input.id}` })
      }
      if (!issue.needsHuman) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'issue has no pending question',
        })
      }
      if (!issue.humanQuestionAskedBy) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'question has no asking session recorded — reply in the session, then clearNeedsHuman',
        })
      }
      if (!ctx.deps.answerSessionQuestion) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'answer delivery is not wired on this node',
        })
      }
      const r = await ctx.deps.answerSessionQuestion(
        issue.humanQuestionAskedBy,
        input.answer,
        ctx.caller,
      )
      if (!r.ok) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `answer not delivered: ${r.message}`,
        })
      }
      return { issue: await ctx.attention.clearNeedsHuman(input.id), deliveredVia: r.via }
    },
  }),
  clearNeedsHuman: def('clearNeedsHuman', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await ctx.attention.clearNeedsHuman(input.id),
  }),
  move: def('move', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => await ctx.crud.move(input.id, input),
  }),
  reparent: def('reparent', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // This lets an agent repair its own planning hierarchy without recreating issues.
    target: targetId,
    handler: async (ctx, input) => {
      // B2 [spec:SP-6144]: reparenting a proposal pulls it out of the lane's
      // structural definition (top-level), and reparenting work UNDER a
      // proposal runs activity beneath an unapproved item — both operator-only.
      await assertNotProposedForAgent(ctx, input.id, 'reparent')
      if (input.parentId != null) {
        await assertNotProposedForAgent(ctx, input.parentId, 'nest work under')
      }
      return await ctx.hierarchy.reparent(input.id, input.parentId)
    },
  }),
  /**
   * POD-679 — the operator's answer to "part of this, or its own thing?".
   *
   * The two placements are the SAME decision seen from both sides, so they are
   * one command rather than a reparent the caller has to remember to pair with
   * a dep edit. Order matters within each: the provenance edge is written
   * BEFORE the parent link is dropped, so no interleaving leaves the issue
   * top-level with nothing pointing back at where it came from.
   *
   * Operator-only, like `promote`: this is the triage decision itself. An agent
   * that wants to file work in one shape or the other already says so at
   * creation (`attach --subissue` / `--spinoff`).
   */
  setPlacement: def('setPlacement', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      if (!isPersonCapability(ctx.caller.capability)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'only an operator may decide where discovered work lives',
        })
      }
      if (input.id === input.originId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'an issue cannot be its own origin' })
      }
      const issue = await ctx.reports.get(input.id)
      if (!issue) throw new TRPCError({ code: 'NOT_FOUND', message: `unknown issue ${input.id}` })
      const origin = await ctx.reports.get(input.originId)
      if (!origin) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `unknown issue ${input.originId}` })
      }
      // POD-781: outboxed, so the PAIR of writes below is guarded as one. The
      // operator check and the two lookups stay outside the ledger, like
      // `archive`'s scope guard does — D8 re-authorizes at every apply, and a
      // replayed placement must not be waved through on a receipt minted when
      // the caller's scope looked different.
      return await ctx.withMutation(input.mutationId, async () => {
        if (input.placement === 'own') {
          const withEdge = await ctx.hierarchy.addDep(input.id, input.originId, 'discovered-from')
          return issue.parentId ? await ctx.hierarchy.reparent(input.id, null) : withEdge
        }
        await ctx.hierarchy.reparent(input.id, input.originId)
        // The edge is removed only after the parent link exists, and only the one
        // pointing at THIS origin — an issue discovered from somewhere else keeps
        // saying so.
        return await ctx.hierarchy.removeDep(input.id, input.originId, 'discovered-from')
      })
    },
  }),
  claim: def('claim', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      await assertNotProposedForAgent(ctx, input.id, 'claim')
      const actorSessionId = ctx.caller.capability.actorSessionId
      // An AGENT's claim starts work and leaves the assignee alone, whatever it
      // names (POD-6287): agents never change the human assignee, and
      // `claim --assignee me` is every agent's habit. A PERSON's claim names
      // the assignee, `me` by default.
      const person = personHuman(ctx)
      const owner =
        person === undefined ? undefined : await assigneeNamed(ctx, input.assignee ?? 'me')
      const caller = ctx.markerUser()
      return await ctx.crud.claim(input.id, {
        ...(actorSessionId ? { actorSessionId } : {}),
        ...(owner ? { owner } : {}),
        ...(caller ? { caller, participation: person === undefined ? 'agent' : 'join' } : {}),
      })
    },
  }),
  /** Claim / set / clear the issue's designated coordinator session
   *  (docs/agent-comms-target.html §05 q1). Actionable issue-addressed mail
   *  prefers this session when it is live. Dangling-tolerant (no session FK). */
  setCoordinator: def('setCoordinator', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      let sessionId: SessionId | null
      if (input.claim) {
        const actor = ctx.caller.capability.actorSessionId
        if (!actor) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'coordinator --claim requires a session-bound caller',
          })
        }
        sessionId = actor
      } else if (input.sessionId !== undefined) {
        sessionId = input.sessionId
      } else {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'pass claim:true, sessionId:<id>, or sessionId:null to clear',
        })
      }
      await assertOwnCoordinatorSeat(ctx, input.id, sessionId)
      return await ctx.crud.setCoordinator(input.id, sessionId)
    },
  }),
  close: def('close', {
    kind: 'mutation',
    target: targetId,
    handler: async (ctx, input) => {
      await assertNotProposedForAgent(ctx, input.id, 'close')
      await assertDecisionNotClosedByAgent(ctx, input.id, 'close')
      await assertNoWorkingSessionsForAgentClose(ctx, input.id, input.confirmInterrupt)
      // `declined` is how a proposal is dismissed (POD-6119, flight deck provisional
      // default): stored as `cancelled`, so every reader counts it as one, with the
      // word kept in a comment — written only by the close that closed it.
      const declined = input.reason?.trim().toLowerCase() === 'declined'
      return await ctx.withMutation(input.mutationId, async () => {
        const before = declined ? await ctx.reports.get(input.id) : null
        const wasOpen = before != null && !isIssueClosed(before)
        const caller = ctx.markerUser()
        const closed = await ctx.crud.close(input.id, declined ? 'cancelled' : input.reason, {
          actorSessionId: ctx.caller.capability.actorSessionId,
          ...(caller ? { caller } : {}),
        })
        return wasOpen
          ? await ctx.commentsMail.addCallerComment(input.id, 'Declined.', ctx.requirePrincipal())
          : closed
      })
    },
  }),
  supersede: def('supersede', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // The mutated subject is oldId; newId remains a relation destination.
    target: (i) => i.oldId as string,
    handler: async (ctx, input) => {
      await assertNotProposedForAgent(ctx, input.oldId, 'supersede')
      await assertDecisionNotClosedByAgent(ctx, input.oldId, 'supersede')
      return await ctx.hierarchy.supersede(input.oldId, input.newId)
    },
  }),
  duplicate: def('duplicate', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // The mutated subject is id; canonicalId remains a relation destination.
    target: targetId,
    handler: async (ctx, input) => {
      await assertNotProposedForAgent(ctx, input.id, 'mark duplicate')
      await assertDecisionNotClosedByAgent(ctx, input.id, 'mark duplicate')
      return await ctx.hierarchy.duplicate(input.id, input.canonicalId)
    },
  }),

  // ---- agent mail (issue #103). Local-only (never hub-forwarded): message ids
  // and mailboxes live on this node.

  // Write, DELIBERATELY NOT scope-gated (no `target`): mail is an append-only
  // mailbox and addressing ANOTHER issue is the whole point of it — cross-issue
  // sends must not require --outside-scope. Treated like `create` (a write with
  // no existing-target issue), so the role gate still applies.
  mailSend: def('mailSend', {
    kind: 'mutation',
    // Unified substrate (#237) [spec:SP-34d7]: the send persists a `messages`
    // row + delivery ledger and mirrors the legacy issue_messages row (same
    // id), so the wire shape (IssueMessageRow) is unchanged for the CLI/MCP.
    handler: async (ctx, input) => {
      // The one send path (POD-4846): there is no second, direct mailbox write.
      const send = ctx.deps.sendMessage
      if (!send) throw new Error('mail sending is not wired on this server')
      const r = await send(ctx.messageSender(), {
        to: { kind: 'issue', id: input.id },
        body: input.body,
        ...(input.messageId ? { messageId: input.messageId } : {}),
      })
      // Surface the honest disposition (#834): held / dead_letter must never be a
      // bare success. The old code discarded r.ok/queued/reason and returned only
      // r.legacy — the exact silent-drop that lost 70 POD-279 messages. When the
      // target was gone there is no mirror row, so synthesize one from the real
      // message so the sender still gets the id AND the disposition.
      const base = r.legacy ?? {
        id: r.message.id,
        issueId: r.message.toId ?? input.id,
        fromAuthor: await ctx.mailIdentity(),
        body: input.body,
        createdAt: r.message.createdAt,
        status: 'unread' as const,
        claimedBy: null,
        readAt: null,
        claimedAt: null,
      }
      return {
        ...base,
        ok: r.ok,
        disposition: r.disposition,
        ...(r.reason ? { reason: r.reason } : {}),
      }
    },
  }),
  // A mutation (listing marks the returned unread messages read), but authz-wise
  // a 'read' — mailbox bookkeeping, not issue mutation. Viewers may check mail.
  mailInbox: def('mailInbox', {
    kind: 'mutation',
    handler: async (ctx, input) => {
      const id = ctx.mailOwnIssue(input?.id)
      // Only the recipient consumes unread status: an agent reading its own
      // mailbox (scope root = the issue). Operator/other-agent peeks must not
      // mark mail read, or delivery to the real recipient is suppressed.
      const markRead =
        ctx.caller.capability.scope.kind === 'subtree' &&
        (await ctx.reports.resolveRef(id)) === ctx.caller.capability.scope.rootId
      // WHICH session is reading [POD-1379]: the mailbox is shared by every
      // agent on the issue, so the read is consumed per reader. Server-stamped
      // from the caller (mailIdentity pattern); client input never contributes.
      const member = ctx.markerUser()
      const rows = await ctx.commentsMail.mailInbox(asIssueId(id), {
        markRead,
        ...(ctx.caller.capability.actorSessionId
          ? { sessionId: ctx.caller.capability.actorSessionId }
          : {}),
        // The reading agent's human (POD-6291): their read marker, nobody else's.
        ...(member ? { member } : {}),
      })
      // MAIL IS PRIVATE (POD-6284, POD-6288). An agent reads its own subtree's
      // boxes whole; anyone else, a person included, sees only the rows the mail
      // read rule gives them, the same as show, status, the ledger and inbox.
      const scope = ctx.caller.capability.scope
      const resolved = await ctx.reports.resolveRef(id)
      const inSubtree =
        scope.kind === 'subtree' &&
        (scope.rootId === resolved ||
          (await ctx.hierarchy.ancestorIds(resolved)).includes(scope.rootId))
      if (inSubtree || !ctx.deps.mailVisibleIds) return rows
      const visible = await ctx.deps.mailVisibleIds(
        ctx.caller.capability,
        rows.map((row) => row.id),
      )
      return rows.filter((row) => visible.has(row.id))
    },
  }),
  // Write, scoped to the caller's own subtree; the target issue lives behind the
  // MESSAGE id, which a pure input extractor cannot resolve — `target` returns
  // undefined (documenting the intent, keeping the completeness checks total)
  // and the SAME shared check (#25) runs in the handler against the message's
  // issue — identical codes and messages. NOT hub-forwarded (message ids are
  // node-local).
  mailClaim: def('mailClaim', {
    kind: 'mutation',
    target: () => undefined,
    handler: async (ctx, input) => {
      const msg = await ctx.commentsMail.mailMessage(input.messageId)
      if (!msg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `unknown mail message ${input.messageId}`,
        })
      }
      await ctx.requireReadableIssue(msg.issueId)
      await checkIssueAccess(ctx.caller, ctx.access, 'mailClaim', 'write', msg.issueId)
      return await ctx.commentsMail.mailClaim(input.messageId, await ctx.mailIdentity(), {
        // Claiming proves this reader has the message [POD-1379].
        ...(ctx.caller.capability.actorSessionId
          ? { sessionId: ctx.caller.capability.actorSessionId }
          : {}),
      })
    },
  }),
  /** The calling session's seat (POD-6108): whether it may talk to the user
   *  (questions, offers) or which coordinator it asks instead. Read by `podium
   *  issue seat` and by the daemon when it gates a harness's ask-the-user tool. */
  seat: def('seat', {
    kind: 'query',
    handler: async (ctx) => {
      const sessionId = ctx.caller.capability.actorSessionId
      if (!sessionId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'seat is only answerable for a session',
        })
      }
      const scope = ctx.caller.capability.scope
      const seat = await ctx.reports.seatFor(
        sessionId,
        scope.kind === 'subtree' ? scope.rootId : undefined,
      )
      return {
        ...seat,
        text: seatText(seat),
        ...(seat.kind === 'below'
          ? {
              askUserRefusal: seatRefusal(
                seat,
                'Asking the user (a question, or plan-mode approval)',
              ),
            }
          : {}),
      }
    },
  }),
  mailPending: def('mailPending', {
    kind: 'query',
    handler: async (ctx, input) =>
      await ctx.commentsMail.mailPending(asIssueId(ctx.mailOwnIssue(input?.id)), {
        // The stop-hook nag is per READER [POD-1379]: each session on the issue
        // is told once, and none of them can clear a peer's count.
        ...(ctx.caller.capability.actorSessionId
          ? { sessionId: ctx.caller.capability.actorSessionId }
          : {}),
      }),
  }),

  // ---- event subscriptions (event-subscriptions design, Phase B). Local-only
  // (subscriptions live on this node). add/remove/setEnabled operate on the
  // CALLER's own subscriptions (subscriber = the caller), so like mailSend they
  // are 'write' with no existing-issue target — the source-within-subtree /
  // own-row checks live in the handlers. list is a read of the caller's own rows.

  subscriptionAdd: def('subscriptionAdd', {
    kind: 'mutation',
    handler: async (ctx, input) => {
      // A PERSON names the subscriber (#129 Phase C — the Automations UI), but
      // only one of their own: a session they own or a task assigned to them.
      // Subscriptions are per-user state and a nudge drives the subscriber's
      // agent, so nobody subscribes another member's session, admins included
      // (design §4.1, POD-6288). Agents always subscribe THEMSELVES, so an
      // agent-supplied subscriber is ignored, not an error.
      const human = personHuman(ctx)
      let subscriber: { kind: 'session' | 'issue'; id: string }
      if (human !== undefined && input.subscriber) {
        subscriber = await ownSubscriberOrRefuse(ctx, input.subscriber, human)
        // A person watches any task (tasks are shared) but only their own
        // sessions: another member's session events are private.
        if (
          input.source.kind === 'session' &&
          !(await sessionOwnedBy(ctx, input.source.ref, human))
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'you may watch only your own sessions',
          })
        }
      } else {
        subscriber = ctx.deriveSubscriber()
        // Constrained callers may only watch a source WITHIN their subtree.
        // Relationship sources resolve dynamically against the subscriber's own
        // subtree, so they are always in-scope.
        if (input.source.kind !== 'relationship') await ctx.assertSourceInSubtree(input.source)
      }
      return await ctx.attention.subscriptionAdd({
        subscriberKind: subscriber.kind,
        subscriberId: subscriber.id,
        event: input.event,
        sourceKind: input.source.kind,
        sourceRef: input.source.ref,
        ...(input.deliver?.nudge != null ? { deliverNudge: input.deliver.nudge } : {}),
        ...(input.deliver?.notify != null ? { deliverNotify: input.deliver.notify } : {}),
      })
    },
  }),
  subscriptionRemove: def('subscriptionRemove', {
    kind: 'mutation',
    handler: async (ctx, input) => {
      // Every caller may only remove their OWN subscriptions.
      await assertOwnSubscription(ctx, input.id, 'remove')
      return await ctx.attention.subscriptionRemove(input.id)
    },
  }),
  /** Toggle a subscription on/off (#129 Phase C, Automations UI). Custom
   *  subscriptions only affect the additive dispatcher pass, so disabling one never
   *  touches the built-in handlers — safe and reversible. */
  subscriptionSetEnabled: def('subscriptionSetEnabled', {
    kind: 'mutation',
    handler: async (ctx, input) => {
      // Every caller may only toggle their OWN subscriptions.
      await assertOwnSubscription(ctx, input.id, 'toggle')
      return ctx.attention.subscriptionSetEnabled(input.id, input.enabled)
    },
  }),
  subscriptionList: def('subscriptionList', {
    kind: 'query',
    // The input is optional, so `query()` (no args) stays valid on every client.
    handler: async (ctx, input) => {
      // A person sees their own subscriptions, one keyset page at a time
      // (POD-6208; the first page when it names none, POD-6209; narrowed to
      // their own by POD-6288). An agent sees its own.
      const human = personHuman(ctx)
      if (human !== undefined) return await ctx.attention.subscriptionOwnPage(human, input ?? {})
      const subscriber = ctx.deriveSubscriber()
      return await ctx.attention.subscriptionList({ subscriberId: subscriber.id })
    },
  }),
} satisfies Record<IssueContractName, AnyIssueCommandDef>

/** The one issues command registry — namespace + defs (see module doc). */
export const issueRegistry = defineCommands('issues', defs)

export type IssueRegistryDefs = typeof issueRegistry.defs

/** The target EXISTING-issue id a command mutates, per its registry definition —
 *  the replacement for indexing the old SCOPED_TARGET map by proc name. */
export function commandTarget(name: string, input: Record<string, unknown>): string | undefined {
  return (issueRegistry.defs as Record<string, AnyIssueCommandDef | undefined>)[name]?.target?.(
    input,
  )
}

/**
 * THE capability guard, shared VERBATIM by the derived tRPC middleware and the
 * in-process dispatch (relay/MCP) — previously two hand-kept copies (router
 * middleware + IssueCommandService.guard). Runs on the RAW input BEFORE zod
 * parsing, mirroring middleware-before-input ordering. Two gates:
 * (1) role gate ⇒ FORBIDDEN; (2) out-of-subtree write on an existing target ⇒
 * PRECONDITION_FAILED unless overridden (--outside-scope). The action and the
 * target extractor come from the DEFINITION — no path-string parsing.
 */
export async function guardIssueCommand(
  caller: IssueCaller,
  reports: IssueCommandAccess,
  name: string,
  def: Pick<AnyIssueCommandDef, 'action' | 'target'>,
  rawInput: unknown,
): Promise<void> {
  // Target extraction: only for constrained caps writing an existing target
  // issue. A member's own scope (a person's, or a legacy persisted `all`)
  // reaches every task (design §4.1, POD-6288), so its target decides nothing.
  const memberScope =
    caller.capability.scope.kind === 'owned' || caller.capability.scope.kind === 'all'
  const extract = memberScope ? undefined : def.target
  let targetId: string | undefined
  if (extract) {
    const rawTarget = extract((rawInput ?? {}) as Record<string, unknown>)
    // Resolve display refs (#seq) to the internal id BEFORE the subtree check —
    // scope.rootId is an internal id, so comparing the raw ref would
    // false-negative on the agent's own bound issue. Scope the resolution to the
    // bound issue's repo (by repo_id) so a bare `#N` disambiguates to the agent's
    // own repo (#140).
    const scopeRepoPath =
      caller.capability.scope.kind === 'subtree'
        ? ((await reports.getMeta(caller.capability.scope.rootId))?.repoPath ?? undefined)
        : undefined
    targetId =
      typeof rawTarget === 'string' ? await reports.resolveRef(rawTarget, scopeRepoPath) : rawTarget
  }
  // The shared decision + throw shape (#25) — also used by the in-handler mailClaim gate.
  await checkIssueAccess(caller, reports, name, def.action, targetId)
}
