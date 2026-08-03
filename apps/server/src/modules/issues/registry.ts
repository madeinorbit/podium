import {
  type CommandAction,
  type ConflictClass,
  type ContractConflictClass,
  type ContractInput,
  defineCommands,
  ISSUE_CONTRACTS,
  type IssueContractName,
} from '@podium/commands'
import type { SessionId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import { attributionOf } from '../../command-principal'
import { checkIssueAccess } from '../../issue-authz'
import { sessionsForIssue } from '../../issue-util'
import type { IssueCaller, IssueCommandAccess, IssueCommandCtx } from './command-ctx'

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

/** Guardrail 2 [spec:SP-6144]: lifecycle moves on a proposed issue are
 *  operator-only, and the check FAILS CLOSED — an id that doesn't resolve is
 *  rejected too, so a bad ref (or a hub mirror the local get() can't see) can
 *  never dodge the lane. Operator callers (scope 'all') pass through untouched.
 *  `verb` completes "only an operator may <verb> a proposed issue". */
function assertNotProposedForAgent(
  ctx: {
    reports: { get(id: string): { stage: string } | null }
    caller: IssueCaller
  },
  id: string,
  verb: string,
): void {
  if (ctx.caller.capability.scope.kind === 'all') return
  let stage: string | undefined
  try {
    stage = ctx.reports.get(id)?.stage
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
): IssueCommandDef<K, (typeof ISSUE_CONTRACTS)[N]['input'], Out> {
  const contract = ISSUE_CONTRACTS[name]
  return {
    ...d,
    input: contract.input,
    action: contract.policy.action,
    // Every contract declares a class since POD-1250, so this is an
    // unconditional read — a query's is `'n/a'`. The `conflictRule` below stays
    // conditional because it belongs to `cmd` rows alone.
    conflict: contract.conflict,
    ...('conflictRule' in contract ? { conflictRule: contract.conflictRule } : {}),
  } as unknown as IssueCommandDef<K, (typeof ISSUE_CONTRACTS)[N]['input'], Out>
}

// ---------------------------------------------------------------------------
// The target extractor the shipped table used on every `id`-keyed command. The
// input SCHEMAS it used to sit beside now live on the contracts.
// ---------------------------------------------------------------------------

const targetId = (i: Record<string, unknown>) => i.id as string

// ---------------------------------------------------------------------------
// The table. Grouped as the old service was: reads, writes, agent mail,
// event subscriptions. `satisfies` pins the keys to the protocol name list.
// ---------------------------------------------------------------------------

const defs = {
  // ---- reads (action 'read': never scope-gated, viewers allowed) ----

  list: def('list', {
    kind: 'query',
    handler: (ctx, input) => ctx.visibleRows(ctx.reports.list(input.repoPath)),
  }),
  prime: def('prime', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.reports.prime(
        {
          repoPath: input?.repoPath,
          boundIssueId:
            ctx.caller.capability.scope.kind === 'subtree'
              ? ctx.caller.capability.scope.rootId
              : null,
          // Per-reader mail count [POD-1379]; server-stamped, never from input.
          ...(ctx.caller.capability.actorSessionId
            ? { sessionId: ctx.caller.capability.actorSessionId }
            : {}),
        },
        (id) => ctx.mayReadIssue(id),
      ),
  }),
  ready: def('ready', {
    kind: 'query',
    handler: (ctx, input) => ctx.visibleRows(ctx.reports.readyList(input.repoPath)),
  }),
  blocked: def('blocked', {
    kind: 'query',
    handler: (ctx, input) => ctx.visibleRows(ctx.reports.blockedList(input.repoPath)),
  }),
  graph: def('graph', {
    kind: 'query',
    handler: (ctx, input) => ctx.visibleGraph(ctx.reports.graph(input.repoPath)),
  }),
  epicStatus: def('epicStatus', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.readIssue(input.id, () => ctx.reports.epicStatus(input.id, (id) => ctx.mayReadIssue(id))),
  }),
  children: def('children', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.readIssue(input.id, () =>
        ctx.reports.children(input.id, input.recursive ?? false, (id) => ctx.mayReadIssue(id)),
      ),
  }),
  tree: def('tree', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.reports.tree(
        input.id,
        {
          ...(input.maxDepth != null ? { maxDepth: input.maxDepth } : {}),
          ...(input.maxNodes != null ? { maxNodes: input.maxNodes } : {}),
        },
        (id) => ctx.mayReadIssue(id),
      ),
  }),
  depReport: def('depReport', {
    kind: 'query',
    handler: (ctx, input) => ctx.reports.depReport(input, (id) => ctx.mayReadIssue(id)),
  }),
  closeEligibleEpics: def('closeEligibleEpics', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.reports.closeEligibleEpics(input.repoPath, (id) => ctx.mayReadIssue(id)),
  }),
  findDuplicates: def('findDuplicates', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.reports.findDuplicates(input.repoPath, input.threshold, (id) => ctx.mayReadIssue(id)),
  }),
  stale: def('stale', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.reports.staleList(input.repoPath, input.days, Date.now(), (id) => ctx.mayReadIssue(id)),
  }),
  lint: def('lint', {
    kind: 'query',
    handler: (ctx, input) => ctx.reports.lint(input.repoPath, (id) => ctx.mayReadIssue(id)),
  }),
  doctor: def('doctor', {
    kind: 'query',
    handler: (ctx, input) => ctx.reports.doctor(input.repoPath, (id) => ctx.mayReadIssue(id)),
  }),
  preflight: def('preflight', {
    kind: 'query',
    handler: (ctx, input) => ctx.reports.preflight(input.repoPath, (id) => ctx.mayReadIssue(id)),
  }),
  search: def('search', {
    kind: 'query',
    handler: (ctx, input) => ctx.reports.search(input, (id) => ctx.mayReadIssue(id)),
  }),
  count: def('count', {
    kind: 'query',
    handler: (ctx, input) => ctx.reports.count(input.repoPath, (id) => ctx.mayReadIssue(id)),
  }),
  stats: def('stats', {
    kind: 'query',
    handler: (ctx, input) => ctx.reports.stats(input.repoPath, (id) => ctx.mayReadIssue(id)),
  }),
  orphans: def('orphans', {
    kind: 'query',
    handler: (ctx, input) => ctx.reports.orphans(input.repoPath, (id) => ctx.mayReadIssue(id)),
  }),
  get: def('get', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.readIssue(input.id, () => {
        const issue = ctx.reports.get(input.id)
        if (!issue) return null
        // The issue's live sessions ride the read (ab75ab1e). `shell` panes are
        // not agents on the issue, so they are not listed as such.
        const sessions = sessionsForIssue(
          issue.worktreePath,
          ctx.deps.listSessions(),
          issue.id,
        ).filter((session) => session.agentKind !== 'shell')
        return { ...issue, sessions }
      }),
  }),
  /** Lazy comment fetch (#175) — bodies left IssueWire (commentCount rides it).
   *  A read (like get/list). Hub-mirrored issues have no local thread: their
   *  comments live on the hub, so this returns []. */
  comments: def('comments', {
    kind: 'query',
    handler: (ctx, input) => ctx.readIssue(input.id, () => ctx.commentsMail.comments(input.id)),
  }),
  events: def('events', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.reports.listEvents(input.since, {
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
        ...(input.limit != null ? { limit: input.limit } : {}),
      }),
  }),
  // hits the external Linear API — 'write' keeps read-only callers from driving it
  linearSearch: def('linearSearch', {
    kind: 'query',
    handler: (ctx, input) => ctx.gitWorkflow.linearSearch(input.query),
  }),

  // ---- writes (scope-gated on their existing target via `target`) ----

  // agent-posted current state (activityNotes) — same nature as panelApply
  setState: def('setState', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.crud.setState(input.id, input.text),
  }),
  // agent-published human panel (todos/artifacts/deferred) — part of doing the work
  panelApply: def('panelApply', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => {
      // Artifact ops route through the permanent-store paths ([spec:SP-0fc9]):
      // add pulls a snapshot from the owning daemon before the panel commit;
      // remove also deletes the snapshot dir.
      if (input.op === 'artifact-add') {
        if (!input.path) throw new Error('artifact-add requires a path')
        return ctx.crud.panelArtifactAdd(
          input.id,
          {
            path: input.path,
            ...(input.title ? { title: input.title } : {}),
            ...(input.extraPaths ? { extraPaths: input.extraPaths } : {}),
          },
          ctx.caller.capability.actorSessionId
            ? { actorSessionId: ctx.caller.capability.actorSessionId }
            : undefined,
        )
      }
      if (input.op === 'artifact-remove') {
        if (input.index == null) throw new Error('artifact-remove requires an index')
        return ctx.crud.panelArtifactRemove(input.id, input.index)
      }
      return ctx.crud.panelApply(input.id, {
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
      const isOperator = ctx.caller.capability.scope.kind === 'all'
      const origin: 'human' | 'agent' = isOperator ? 'human' : 'agent'
      // B3 [spec:SP-6144]: a parentId is validated BEFORE anything persists.
      // Previously the row was persisted+broadcast first and reparent threw
      // after, leaving an orphan behind on a bogus parent — and an agent could
      // dodge the top-level/proposed rule by naming ANY existing issue (even a
      // closed or archived one) as parent. Top-levelness is decided only
      // against a real, agent-reachable parent.
      let parent: ReturnType<typeof ctx.reports.get> = null
      if (input.parentId) {
        try {
          parent = ctx.reports.get(input.parentId)
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
      // M5 [spec:SP-6144]: sub-creates under a proposed parent (or deeper in a
      // proposal subtree) stay inert — never auto-started, never board-facing.
      const underProposed =
        parent != null && !isOperator && ctx.hierarchy.inProposedSubtree(parent.id)
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
      return ctx.withMutation(input.mutationId, async () => {
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
        const created = await ctx.gitWorkflow.createAndMaybeStart(
          {
            ...input,
            origin,
            audience,
            startedBySession,
            ownerUserId: attribution.onBehalfOf,
            visibility: 'personal' as const,
            createdByActor: attribution.actor,
            createdByOnBehalfOf: attribution.onBehalfOf,
            ...(isAgentTopLevel ? { stage: 'proposed' as const, startNow: false } : {}),
            ...(underProposed ? { startNow: false } : {}),
          },
          { spawnedBy: ctx.spawnProvenance() },
        )
        if (audience === 'agent' && !ctx.hasHumanAudienceAncestor(created)) {
          return {
            ...created,
            warning:
              'This issue is invisible: it is internal (audience: agent) but has no ' +
              'human-facing parent. Pass `--audience human`, or attach to an issue first ' +
              'so it nests under a tracked parent.',
          }
        }
        return created
      })
    },
  }),
  start: def('start', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => {
      // M5 [spec:SP-6144]: the whole proposal SUBTREE is inert — a sub-issue
      // filed under a proposed parent cannot be started to run work under an
      // unapproved proposal, so the ancestor chain is checked, not just the row.
      assertNotProposedForAgent(ctx, input.id, 'start')
      if (ctx.caller.capability.scope.kind !== 'all') {
        for (const anc of ctx.hierarchy.ancestorIds(input.id)) {
          assertNotProposedForAgent(ctx, anc, 'start work under')
        }
      }
      return ctx.gitWorkflow.start(input.id, input.agentKind, {
        spawnedBy: ctx.spawnProvenance(),
        // Explicit per-launch choice (POD-1545); persists onto the issue profile.
        ...(input.defaultModel ? { model: input.defaultModel } : {}),
        ...(input.defaultEffort ? { effort: input.defaultEffort } : {}),
        ...(input.forceUnknownModel ? { forceUnknownModel: true } : {}),
      })
    },
  }),
  update: def('update', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) =>
      ctx.withMutation(input.mutationId, () => {
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
        if (movesLifecycle) assertNotProposedForAgent(ctx, input.id, 'promote')
        return ctx.crud.update(input.id, input.patch, {
          actorSessionId: ctx.caller.capability.actorSessionId,
        })
      }),
  }),
  promote: def('promote', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => {
      if (ctx.caller.capability.scope.kind !== 'all') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'only an operator may promote a proposed issue',
        })
      }
      const issue = ctx.reports.get(input.id)
      if (!issue) throw new TRPCError({ code: 'NOT_FOUND', message: `unknown issue ${input.id}` })
      if (issue.stage !== 'proposed') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'issue is not proposed' })
      }
      return ctx.crud.update(input.id, { stage: 'backlog' })
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
    handler: (ctx, input) => {
      const origin: 'human' | 'agent' =
        ctx.caller.capability.scope.kind === 'all' ? 'human' : 'agent'
      // B2/M5 [spec:SP-6144]: a session may not re-home onto (or file a
      // sub-issue under) a proposed issue — the proposal subtree is inert.
      if (input.targetId != null) {
        assertNotProposedForAgent(ctx, input.targetId, 'attach a session to')
      }
      const { newSubissue, newSpinoff, ...rest } = input
      return ctx.deps.attachSession(ctx.caller, {
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
    handler: (ctx, input) => {
      assertNotProposedForAgent(ctx, input.id, 'archive')
      return ctx.attention.archive(input.id)
    },
  }),
  delete: def('delete', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.deleteIssue(input.id),
  }),
  restore: def('restore', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.restoreIssue(input.id),
  }),
  action: def('action', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.gitWorkflow.action(input.id, input.kind),
  }),
  // Write, not manage: heavily guarded (closed + merged + clean only), so a
  // closing agent may clean up after itself. Acts on LOCAL git state — it removes a
  // worktree directory and deletes a branch via THIS machine's daemon.
  cleanup: def('cleanup', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.gitWorkflow.cleanup(input.id, ctx.requirePrincipal()),
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
      const r = await ctx.deps.stopIssueSessions({
        issueId: input.id,
        principal: ctx.requirePrincipal(),
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
    handler: (ctx, input) => ctx.gitWorkflow.integrate(input.id, ctx.requirePrincipal()),
  }),
  addSession: def('addSession', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) =>
      ctx.gitWorkflow.addSession(input.id, input.agentKind, {
        spawnedBy: ctx.spawnProvenance(),
        ...(input.forceUnknownModel ? { forceUnknownModel: true } : {}),
      }),
  }),
  addShell: def('addShell', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) =>
      ctx.gitWorkflow.addShell(input.id, { spawnedBy: ctx.spawnProvenance() }),
  }),
  applySuggestion: def('applySuggestion', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.crud.applySuggestion(input.id),
  }),
  dismissSuggestion: def('dismissSuggestion', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.crud.dismissSuggestion(input.id),
  }),
  refreshAssistant: def('refreshAssistant', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.gitWorkflow.refreshAssistant(input.id),
  }),
  setLabels: def('setLabels', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.crud.setLabels(input.id, input.labels),
  }),
  share: def('share', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) =>
      ctx.crud.share(input.id, input.grantee, input.verb, ctx.ownerAttribution(input.id)),
  }),
  unshare: def('unshare', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => {
      ctx.ownerAttribution(input.id)
      return ctx.crud.unshare(input.id, input.grantee, input.verb)
    },
  }),
  addComment: def('addComment', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) =>
      ctx.withMutation(input.mutationId, () =>
        ctx.commentsMail.addComment(input.id, input.author, input.body, ctx.requirePrincipal()),
      ),
  }),
  depAdd: def('depAdd', {
    kind: 'mutation',
    target: (i) => i.fromId as string,
    handler: (ctx, input) => ctx.hierarchy.addDep(input.fromId, input.toId, input.type),
  }),
  depRemove: def('depRemove', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // Removing a mistaken edge is the inverse of the already-agent-safe depAdd.
    target: (i) => i.fromId as string,
    handler: (ctx, input) => ctx.hierarchy.removeDep(input.fromId, input.toId, input.type),
  }),
  defer: def('defer', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.attention.defer(input.id, input.until),
  }),
  // Manual unsnooze (issue #133): ends a snooze and floats the issue back to the
  // top of WORK with the "Unsnoozed" tag (returned-from-defer), unlike defer(null)
  // which quietly clears it. Distinct route so it emits issue.unsnoozed cleanly.
  undefer: def('undefer', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.attention.undefer(input.id),
  }),
  // Mark an issue read (issue #124): stamp read_at = now, flipping derived `unread`.
  // Read-tracking carries 'read' authority only (reading marks read), despite being
  // a mutation on the wire.
  markRead: def('markRead', {
    kind: 'mutation',
    handler: (ctx, input) =>
      ctx.withMutation(input.mutationId, () => ctx.attention.markIssueRead(input.id)),
  }),
  // Mark an issue UNREAD again (issue #138): clear read_at, flipping derived
  // `unread` back to true. Like markRead, read-tracking needs only 'read'.
  markUnread: def('markUnread', {
    kind: 'mutation',
    handler: (ctx, input) =>
      ctx.withMutation(input.mutationId, () => ctx.attention.markIssueUnread(input.id)),
  }),
  // Tuck a finished issue into the sidebar's Closed fold, or bring it back
  // (POD-333). Sidebar curation the operator performs while reading the board —
  // 'read' authority like markRead, despite being a mutation on the wire.
  setTucked: def('setTucked', {
    kind: 'mutation',
    handler: (ctx, input) =>
      ctx.withMutation(input.mutationId, () =>
        ctx.attention.setIssueTucked(input.id, input.tucked),
      ),
  }),
  setNeedsHuman: def('setNeedsHuman', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => {
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
      if (askedBy && ctx.caller.capability.scope.kind !== 'all' && askedBy !== actor) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'askedBy is server-authoritative: agents may only attribute a question to their own session (omit askedBy)',
        })
      }
      return ctx.attention.setNeedsHuman(input.id, input.question ?? null, {
        ...(input.options ? { options: input.options } : {}),
        ...(askedBy ? { askedBy } : {}),
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
    target: targetId,
    handler: async (ctx, input) => {
      const issue = ctx.reports.getMeta(input.id)
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
      return { issue: ctx.attention.clearNeedsHuman(input.id), deliveredVia: r.via }
    },
  }),
  clearNeedsHuman: def('clearNeedsHuman', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => ctx.attention.clearNeedsHuman(input.id),
  }),
  reparent: def('reparent', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // This lets an agent repair its own planning hierarchy without recreating issues.
    target: targetId,
    handler: (ctx, input) => {
      // B2 [spec:SP-6144]: reparenting a proposal pulls it out of the lane's
      // structural definition (top-level), and reparenting work UNDER a
      // proposal runs activity beneath an unapproved item — both operator-only.
      assertNotProposedForAgent(ctx, input.id, 'reparent')
      if (input.parentId != null) {
        assertNotProposedForAgent(ctx, input.parentId, 'nest work under')
      }
      return ctx.hierarchy.reparent(input.id, input.parentId)
    },
  }),
  claim: def('claim', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => {
      assertNotProposedForAgent(ctx, input.id, 'claim')
      return ctx.crud.claim(input.id, input.assignee)
    },
  }),
  /** Claim / set / clear the issue's designated coordinator session
   *  (docs/agent-comms-target.html §05 q1). Actionable issue-addressed mail
   *  prefers this session when it is live. Dangling-tolerant (no session FK). */
  setCoordinator: def('setCoordinator', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => {
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
      return ctx.crud.setCoordinator(input.id, sessionId)
    },
  }),
  close: def('close', {
    kind: 'mutation',
    target: targetId,
    handler: (ctx, input) => {
      assertNotProposedForAgent(ctx, input.id, 'close')
      return ctx.withMutation(input.mutationId, () =>
        ctx.crud.close(input.id, input.reason, {
          actorSessionId: ctx.caller.capability.actorSessionId,
        }),
      )
    },
  }),
  supersede: def('supersede', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // The mutated subject is oldId; newId remains a relation destination.
    target: (i) => i.oldId as string,
    handler: (ctx, input) => {
      assertNotProposedForAgent(ctx, input.oldId, 'supersede')
      return ctx.hierarchy.supersede(input.oldId, input.newId)
    },
  }),
  duplicate: def('duplicate', {
    kind: 'mutation',
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // The mutated subject is id; canonicalId remains a relation destination.
    target: targetId,
    handler: (ctx, input) => {
      assertNotProposedForAgent(ctx, input.id, 'mark duplicate')
      return ctx.hierarchy.duplicate(input.id, input.canonicalId)
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
    handler: (ctx, input) => {
      const send = ctx.deps.sendMessage
      if (!send) return ctx.commentsMail.sendMail(input.id, ctx.mailIdentity(), input.body)
      const r = send(ctx.messageSender(), { to: { kind: 'issue', id: input.id }, body: input.body })
      // Surface the honest disposition (#834): held / dead_letter must never be a
      // bare success. The old code discarded r.ok/queued/reason and returned only
      // r.legacy — the exact silent-drop that lost 70 POD-279 messages. When the
      // target was gone there is no mirror row, so synthesize one from the real
      // message so the sender still gets the id AND the disposition.
      const base = r.legacy ?? {
        id: r.message.id,
        issueId: r.message.toId ?? input.id,
        fromAuthor: ctx.mailIdentity(),
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
    handler: (ctx, input) => {
      const id = ctx.mailOwnIssue(input?.id)
      // Only the recipient consumes unread status: an agent reading its own
      // mailbox (scope root = the issue). Operator/other-agent peeks must not
      // mark mail read, or delivery to the real recipient is suppressed.
      const markRead =
        ctx.caller.capability.scope.kind === 'subtree' &&
        ctx.reports.resolveRef(id) === ctx.caller.capability.scope.rootId
      // WHICH session is reading [POD-1379]: the mailbox is shared by every
      // agent on the issue, so the read is consumed per reader. Server-stamped
      // from the caller (mailIdentity pattern); client input never contributes.
      return ctx.commentsMail.mailInbox(id, {
        markRead,
        ...(ctx.caller.capability.actorSessionId
          ? { sessionId: ctx.caller.capability.actorSessionId }
          : {}),
      })
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
    handler: (ctx, input) => {
      const msg = ctx.commentsMail.mailMessage(input.messageId)
      if (!msg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `unknown mail message ${input.messageId}`,
        })
      }
      ctx.requireReadableIssue(msg.issueId)
      checkIssueAccess(ctx.caller, ctx.access, 'mailClaim', 'write', msg.issueId)
      return ctx.commentsMail.mailClaim(input.messageId, ctx.mailIdentity(), {
        // Claiming proves this reader has the message [POD-1379].
        ...(ctx.caller.capability.actorSessionId
          ? { sessionId: ctx.caller.capability.actorSessionId }
          : {}),
      })
    },
  }),
  mailPending: def('mailPending', {
    kind: 'query',
    handler: (ctx, input) =>
      ctx.commentsMail.mailPending(ctx.mailOwnIssue(input?.id), {
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
    handler: (ctx, input) => {
      // Operator (scope 'all') may create a subscription for an explicit subscriber
      // (#129 Phase C — the Automations UI); constrained agents always subscribe
      // THEMSELVES, so an agent-supplied subscriber is ignored, not an error.
      const subscriber =
        input.subscriber && ctx.caller.capability.scope.kind === 'all'
          ? input.subscriber
          : ctx.deriveSubscriber()
      // Constrained callers may only watch a source WITHIN their subtree; the
      // operator (scope 'all') is unconstrained. Relationship sources resolve
      // dynamically against the subscriber's own subtree, so they are always in-scope.
      if (ctx.caller.capability.scope.kind !== 'all' && input.source.kind !== 'relationship') {
        ctx.assertSourceInSubtree(input.source)
      }
      return ctx.attention.subscriptionAdd({
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
    handler: (ctx, input) => {
      // Constrained callers may only remove their OWN subscriptions.
      if (ctx.caller.capability.scope.kind !== 'all') {
        const subscriber = ctx.deriveSubscriber()
        const owned = ctx.attention
          .subscriptionList({ subscriberId: subscriber.id })
          .some((s) => s.id === input.id)
        if (!owned) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'not allowed to remove a subscription you do not own',
          })
        }
      }
      return ctx.attention.subscriptionRemove(input.id)
    },
  }),
  /** Toggle a subscription on/off (#129 Phase C, Automations UI). Custom
   *  subscriptions only affect the additive dispatcher pass, so disabling one never
   *  touches the built-in handlers — safe and reversible. */
  subscriptionSetEnabled: def('subscriptionSetEnabled', {
    kind: 'mutation',
    handler: (ctx, input) => {
      // Constrained callers may only toggle their OWN subscriptions.
      if (ctx.caller.capability.scope.kind !== 'all') {
        const subscriber = ctx.deriveSubscriber()
        const owned = ctx.attention
          .subscriptionList({ subscriberId: subscriber.id })
          .some((s) => s.id === input.id)
        if (!owned) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'not allowed to toggle a subscription you do not own',
          })
        }
      }
      return ctx.attention.subscriptionSetEnabled(input.id, input.enabled)
    },
  }),
  subscriptionList: def('subscriptionList', {
    kind: 'query',
    // The one historical no-input proc: z.void() keeps `query()` (no args) valid
    // on every client while the registry contract still carries ONE schema.
    handler: (ctx) => {
      // Operator sees every subscription; a constrained caller sees only its own.
      if (ctx.caller.capability.scope.kind === 'all') return ctx.attention.subscriptionList()
      const subscriber = ctx.deriveSubscriber()
      return ctx.attention.subscriptionList({ subscriberId: subscriber.id })
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
export function guardIssueCommand(
  caller: IssueCaller,
  reports: IssueCommandAccess,
  name: string,
  def: Pick<AnyIssueCommandDef, 'action' | 'target'>,
  rawInput: unknown,
): void {
  // Target extraction: only for constrained caps writing an existing target issue.
  const extract = caller.capability.scope.kind !== 'all' ? def.target : undefined
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
        ? (reports.getMeta(caller.capability.scope.rootId)?.repoPath ?? undefined)
        : undefined
    targetId =
      typeof rawTarget === 'string' ? reports.resolveRef(rawTarget, scopeRepoPath) : rawTarget
  }
  // The shared decision + throw shape (#25) — also used by the in-handler mailClaim gate.
  checkIssueAccess(caller, reports, name, def.action, targetId)
}
