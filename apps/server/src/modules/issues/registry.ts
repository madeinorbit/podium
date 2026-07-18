import {
  type CommandDef,
  defineCommands,
  ISSUE_COMMAND_NAMES,
  IssueColor,
  type IssueCommandName,
  IssueStage,
  IssueType,
  type SessionMeta,
} from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { authorize, type Capability, checkIssueAccess } from '../../issue-authz'
import type { IssueProc, IssueTrpc } from '../../issue-client'
import type { MessageSender, MessageSendInput, MessageSendResult } from '../messages/service'
import type { IssueService } from './service'

/**
 * THE issue command registry (#248 [spec:SP-3fe2]): every issues.* command is
 * defined ONCE here — input schema, required action, scope class, target
 * extractor, and the handler over IssueService — and the four surfaces are
 * DERIVED from this table:
 *
 *   - the tRPC `issues:` sub-router (modules/issues/trpc.ts routerFromCommands),
 *   - the in-process command surface serving the daemon relay + MCP
 *     ({@link IssueCommandDispatcher}, replacing the hand-mirrored
 *     IssueCommandService of modules/issues/commands.ts),
 *   - the relay gate's dispatch (relay-gate.ts is transport-only now),
 *   - the `IssueTrpc` client the in-process MCP tools call
 *     ({@link IssueCommandDispatcher.asIssueTrpc}, replacing the Proxy soup).
 *
 * Authorization is declared ON each definition (`action` + `target`), replacing
 * the PROC_ACTION/SCOPED_TARGET string maps keyed by proc name — renaming a
 * command now moves its authz with it instead of silently resetting to 'read'.
 * The def keys are pinned to @podium/protocol's ISSUE_COMMAND_NAMES via
 * `satisfies`, so registry↔contract drift is a compile error.
 */

/** Who is calling (authz identity) — the same pair the router Context carries. */
export interface IssueCaller {
  capability: Capability
  /** The agent passed --outside-scope: a knowing write outside its subtree. */
  overrideScope?: boolean
}

export interface IssueCommandDeps {
  /** Lazy — the IssueService is assigned late in the composition root. */
  issues(): IssueService
  /** Cross-aggregate issue tombstone + member-session deletion coordinator. */
  deleteIssue(id: string): unknown
  /** Cross-aggregate issue + member-session tombstone restoration coordinator. */
  restoreIssue(id: string): unknown
  /** True when `id` is a hub-mirrored issue (modules/issues/upstream). */
  isUpstreamIssue(id: string): boolean
  /** Forward one issue mutation to the hub (viaHub write forwarding, §2.2). */
  forwardIssueMutation(proc: string, input: Record<string, unknown>): Promise<unknown>
  /** repoPaths that exist among hub issues (create's hub-only repo check). */
  upstreamIssueRepoPaths(): Set<string>
  /** Idempotency wrapper (docs/spec/outbox-write-path.md §2.1) — modules/sessions. */
  withMutation<T>(mutationId: string | undefined, proc: string, fn: () => T): T
  /** Session list — subscription source checks resolve session→issue through it. */
  listSessions(): SessionMeta[]
  /** Registered repo paths, all machines (RepoRegistry.list() semantics). */
  repoPaths(): string[]
  /** cwd → repo inference (RepoRegistry.inferFromPath semantics) — serves the
   *  relay-allowlisted `repos.inferFromPath` without touching the router. */
  inferRepoFromPath(path: string): string | undefined
  /** Unified messaging send path (#237) [spec:SP-34d7] — optional so bare test
   *  dispatchers keep working; when absent mailSend falls back to legacy sendMail. */
  sendMessage?(from: MessageSender, input: MessageSendInput): MessageSendResult
  /** Deliver a Tray answer to the asking agent session (issue #53): the shared
   *  answer_question matching path (modules/superagent/answer-delivery) with
   *  text fallback for sessions without a live menu. Injected by the relay;
   *  optional so existing test deps literals stay valid. */
  answerSessionQuestion?(
    sessionId: string,
    answer: string,
  ): Promise<{ ok: true; via: 'menu' | 'text' } | { ok: false; message: string }>
  /** Stop every session on an issue and free its worktree (keep branch)
   *  [spec:SP-9904]. Injected from SessionsService; optional in bare tests. */
  stopIssueSessions?(input: {
    issueId: string
    force?: boolean
    callerSessionId?: string
  }): Promise<{
    ok: boolean
    reason?: string
    stopped: string[]
    worktreeFreed: boolean
  }>
}

export type IssueCommandKind = 'query' | 'mutation'

/**
 * One issue command definition: the protocol CommandDef contract plus the
 * server-side pieces the derivations need.
 *
 * `target` is the old SCOPED_TARGET extractor, now a field ON the definition:
 * how to read the target EXISTING issue id from the raw input. Present exactly
 * on the write/manage commands that mutate an existing issue (`scope: 'issue'`);
 * absent on additive/self-addressed commands (create, mailSend, attachSession,
 * subscription*) and all reads. It feeds BOTH the capability guard's subtree
 * check ({@link guardIssueCommand}) and the viaHub forwarding detection
 * ({@link commandTarget}, consumed by modules/issues/upstream.ts).
 */
export interface IssueCommandDef<
  K extends IssueCommandKind = IssueCommandKind,
  In extends z.ZodTypeAny = z.ZodTypeAny,
  Out = unknown,
> extends CommandDef<In, Out> {
  /** tRPC procedure type this command mounts as. */
  kind: K
  /** Target EXISTING-issue id extractor (see interface doc). */
  target?: (input: Record<string, unknown>) => string | undefined
  /** The command body — calls IssueService directly (the logic lives THERE). */
  handler: (ctx: IssueCommandCtx, input: z.infer<In>) => Out
}

/** The generics-erased wildcard shape (what heterogeneous collections of defs
 *  are typed as). Structural rather than `IssueCommandDef<…, any>` so zod's
 *  nominal-ish schema generics never fight assignability. */
export type AnyIssueCommandDef = {
  kind: IssueCommandKind
  input: z.ZodTypeAny
  action: CommandDef['action']
  scope?: CommandDef['scope']
  cli?: CommandDef['cli']
  target?: (input: Record<string, unknown>) => string | undefined
  // biome-ignore lint/suspicious/noExplicitAny: the wildcard def erases per-command generics on purpose
  handler: (ctx: IssueCommandCtx, input: any) => any
}

/** Identity helper that PRESERVES the per-def generics (kind literal, input
 *  schema, handler output) so the derived tRPC router keeps precise types. */
function def<K extends IssueCommandKind, In extends z.ZodTypeAny, Out>(
  d: IssueCommandDef<K, In, Out>,
): IssueCommandDef<K, In, Out> {
  return d
}

// ---------------------------------------------------------------------------
// Shared input fragments (the single validation source for tRPC/relay/MCP).
// ---------------------------------------------------------------------------

const repoScoped = z.object({ repoPath: z.string().optional() })
const byId = z.object({ id: z.string() })
const targetId = (i: Record<string, unknown>) => i.id as string

/**
 * Per-call execution context handed to every command handler: the caller's
 * authz identity, the IssueService, and the cross-cutting helpers (viaHub write
 * forwarding, withMutation idempotency, mail identity, subscription scoping)
 * that used to be private methods of IssueCommandService.
 */
export class IssueCommandCtx {
  constructor(
    readonly deps: IssueCommandDeps,
    readonly caller: IssueCaller,
    private readonly name: string,
    private readonly targetOf?: (input: Record<string, unknown>) => string | undefined,
  ) {}

  get issues(): IssueService {
    return this.deps.issues()
  }
  deleteIssue(id: string): unknown {
    return this.deps.deleteIssue(id)
  }
  restoreIssue(id: string): unknown {
    return this.deps.restoreIssue(id)
  }

  /** Idempotency wrapper bound to this command's wire name (issues.<name>). */
  withMutation<T>(mutationId: string | undefined, fn: () => T): T {
    return this.deps.withMutation(mutationId, `issues.${this.name}`, fn)
  }

  /**
   * viaHub write forwarding (docs/spec/node-hub-issues.md §2.2): a mutation whose
   * target is a hub-mirrored issue is handed to the upstream forwarder instead of
   * the local IssueService — `{ queued: true }` when the hub is unreachable, the
   * hub's own result when it is. Only the unconstrained operator may act on hub
   * issues; node-side agents/assistants never do (§2.3).
   */
  issueWrite<R>(
    input: Record<string, unknown>,
    local: () => R,
  ): R | Promise<Awaited<R> | { queued: true }> {
    const target = this.targetOf?.(input)
    if (typeof target === 'string' && this.deps.isUpstreamIssue(target)) {
      if (this.caller.capability.scope.kind !== 'all') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'issue is managed via the hub — agents cannot act on hub issues from this node',
        })
      }
      // The hub runs the same registry, so its result IS this command's result
      // shape — plus the offline `{ queued: true }` outcome (spec §2.2).
      return this.deps.forwardIssueMutation(this.name, input) as Promise<
        Awaited<R> | { queued: true }
      >
    }
    return local()
  }

  /** Agent-mail sender/claimer identity: the caller's bound issue (`issue:#<seq>`)
   *  for a subtree-scoped agent, else 'operator'. */
  mailIdentity(): string {
    if (this.caller.capability.scope.kind === 'subtree') {
      const me = this.issues.getMeta(this.caller.capability.scope.rootId)
      if (me) return `issue:#${me.seq}`
    }
    return 'operator'
  }

  /** Structured sender principal for the unified substrate (#237)
   *  [spec:SP-34d7] — server-stamped from the caller, mirroring mailIdentity():
   *  a subtree-scoped caller is an agent on its root issue; ONLY the
   *  unconstrained scope ('all') is the operator — an issueless agent session
   *  (scope 'none' + actorSessionId) stamps as an agent, or it would send
   *  unwrapped/unclamped as the human ("unwrapped = operator" invariant).
   *  Client input NEVER contributes sender fields. */
  messageSender(): MessageSender {
    if (this.caller.capability.scope.kind === 'subtree') {
      return {
        kind: 'agent',
        issueId: this.caller.capability.scope.rootId,
        ...(this.caller.capability.actorSessionId
          ? { sessionId: this.caller.capability.actorSessionId }
          : {}),
      }
    }
    if (this.caller.capability.scope.kind === 'all') return { kind: 'operator' }
    return {
      kind: 'agent',
      ...(this.caller.capability.actorSessionId
        ? { sessionId: this.caller.capability.actorSessionId }
        : {}),
    }
  }

  /** Server-derived provenance for a session spawned by an issue command.
   *  Preserve the exact initiating session when one exists; otherwise distinguish
   *  the operator from legacy constrained callers. [spec:SP-ccb2] */
  spawnProvenance(): string {
    if (this.caller.capability.actorSessionId) {
      return `session:${this.caller.capability.actorSessionId}`
    }
    if (this.caller.capability.scope.kind === 'all') return 'user'
    if (this.caller.capability.scope.kind === 'subtree') {
      return `issue:${this.caller.capability.scope.rootId}`
    }
    return 'agent'
  }

  /** Resolve an omitted mail issue ref to the caller's own bound issue (capability rootId). */
  mailOwnIssue(id?: string): string {
    if (id) return id
    if (this.caller.capability.scope.kind === 'subtree') return this.caller.capability.scope.rootId
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'no issue bound to this caller; pass an issue id',
    })
  }

  /** The subscriber a subscription defaults to: the CALLER. A relayed agent's own
   *  session (capability.actorSessionId) when the call is session-bound, else its
   *  subtree root issue. The operator (scope 'all', no actor) has no implicit
   *  subscriber — it manages subscriptions via the Automations UI (Phase C). */
  deriveSubscriber(): { kind: 'session' | 'issue'; id: string } {
    if (this.caller.capability.actorSessionId) {
      return { kind: 'session', id: this.caller.capability.actorSessionId }
    }
    if (this.caller.capability.scope.kind === 'subtree') {
      return { kind: 'issue', id: this.caller.capability.scope.rootId }
    }
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'no subscriber bound to this caller; subscriptions are created by a bound agent',
    })
  }

  /** Enforce that a constrained caller only watches an issue/session source WITHIN
   *  its subtree (mirrors the scope gate, which cannot reach into the `source`
   *  shape). Relationship sources are resolved against the caller's own subtree
   *  at match time, so they never reach here. */
  assertSourceInSubtree(source: { kind: 'relationship' | 'issue' | 'session'; ref: string }): void {
    if (source.kind === 'issue') {
      const id = this.issues.resolveRef(source.ref)
      const decision = authorize(
        this.caller.capability,
        'write',
        { id, ancestorIds: this.issues.ancestorIds(id) },
        { override: this.caller.overrideScope },
      )
      if (decision === 'confirm-required') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `source issue ${id} is outside your subtree; re-run with --outside-scope to confirm`,
        })
      }
      if (decision === 'forbidden') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'not allowed to watch that source' })
      }
      return
    }
    // session source: the caller's own session, or one bound to an in-subtree issue.
    if (source.ref === this.caller.capability.actorSessionId) return
    const bound = this.deps.listSessions().find((s) => s.sessionId === source.ref)?.issueId
    const ok =
      bound != null &&
      authorize(this.caller.capability, 'write', {
        id: bound,
        ancestorIds: this.issues.ancestorIds(bound),
      }) === 'allow'
    if (!ok) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'not allowed to watch a session outside your subtree',
      })
    }
  }

  /** Walk an issue's parent chain; true iff some ancestor is human-audience —
   *  i.e. the board's filterBoardScope will surface this (internal) issue nested
   *  under it. Cycle-guarded. (#198) */
  hasHumanAudienceAncestor(issue: { parentId?: string | null }): boolean {
    const seen = new Set<string>()
    let parentId: string | null | undefined = issue.parentId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = this.issues.getMeta(parentId)
      if (!parent) return false
      if (parent.audience === 'human') return true
      parentId = parent.parentId
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// The table. Grouped as the old service was: reads, writes, agent mail,
// event subscriptions. `satisfies` pins the keys to the protocol name list.
// ---------------------------------------------------------------------------

const defs = {
  // ---- reads (action 'read': never scope-gated, viewers allowed) ----

  list: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.list(input.repoPath),
  }),
  prime: def({
    kind: 'query',
    input: repoScoped.optional(),
    action: 'read',
    handler: (ctx, input) =>
      ctx.issues.prime({
        repoPath: input?.repoPath,
        boundIssueId:
          ctx.caller.capability.scope.kind === 'subtree'
            ? ctx.caller.capability.scope.rootId
            : null,
      }),
  }),
  ready: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.readyList(input.repoPath),
  }),
  blocked: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.blockedList(input.repoPath),
  }),
  graph: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.graph(input.repoPath),
  }),
  epicStatus: def({
    kind: 'query',
    input: byId,
    action: 'read',
    handler: (ctx, input) => ctx.issues.epicStatus(input.id),
  }),
  children: def({
    kind: 'query',
    input: z.object({ id: z.string(), recursive: z.boolean().optional() }),
    action: 'read',
    handler: (ctx, input) => ctx.issues.children(input.id, input.recursive ?? false),
  }),
  tree: def({
    kind: 'query',
    input: byId,
    action: 'read',
    handler: (ctx, input) => ctx.issues.tree(input.id),
  }),
  depReport: def({
    kind: 'query',
    input: z.object({ id: z.string().optional(), repoPath: z.string().optional() }),
    action: 'read',
    handler: (ctx, input) => ctx.issues.depReport(input),
  }),
  closeEligibleEpics: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.closeEligibleEpics(input.repoPath),
  }),
  findDuplicates: def({
    kind: 'query',
    input: z.object({ repoPath: z.string().optional(), threshold: z.number().optional() }),
    action: 'read',
    handler: (ctx, input) => ctx.issues.findDuplicates(input.repoPath, input.threshold),
  }),
  stale: def({
    kind: 'query',
    input: z.object({ repoPath: z.string().optional(), days: z.number().optional() }),
    action: 'read',
    handler: (ctx, input) => ctx.issues.staleList(input.repoPath, input.days),
  }),
  lint: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.lint(input.repoPath),
  }),
  doctor: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.doctor(input.repoPath),
  }),
  preflight: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.preflight(input.repoPath),
  }),
  search: def({
    kind: 'query',
    input: z.object({
      repoPath: z.string().optional(),
      text: z.string().optional(),
      status: z.enum(['open', 'closed', 'ready', 'blocked', 'deferred']).optional(),
      stage: IssueStage.optional(),
      priority: z.number().int().optional(),
      type: IssueType.optional(),
      assignee: z.string().optional(),
      label: z.string().optional(),
      parentId: z.string().optional(),
    }),
    action: 'read',
    handler: (ctx, input) => ctx.issues.search(input),
  }),
  count: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.count(input.repoPath),
  }),
  stats: def({
    kind: 'query',
    input: repoScoped,
    action: 'read',
    handler: (ctx, input) => ctx.issues.stats(input.repoPath),
  }),
  orphans: def({
    kind: 'query',
    input: z.object({ repoPath: z.string() }),
    action: 'read',
    handler: (ctx, input) => ctx.issues.orphans(input.repoPath),
  }),
  get: def({
    kind: 'query',
    input: byId,
    action: 'read',
    handler: (ctx, input) => ctx.issues.get(input.id),
  }),
  /** Lazy comment fetch (#175) — bodies left IssueWire (commentCount rides it).
   *  A read (like get/list). Hub-mirrored issues have no local thread: their
   *  comments live on the hub, so this returns []. */
  comments: def({
    kind: 'query',
    input: byId,
    action: 'read',
    handler: (ctx, input) => {
      if (ctx.deps.isUpstreamIssue(input.id)) return []
      return ctx.issues.comments(input.id)
    },
  }),
  events: def({
    kind: 'query',
    input: z.object({
      since: z.number().int().min(0).default(0),
      kinds: z.array(z.string()).optional(),
      repoPath: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    action: 'read',
    handler: (ctx, input) =>
      ctx.issues.listEvents(input.since, {
        ...(input.kinds ? { kinds: input.kinds } : {}),
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
        ...(input.limit != null ? { limit: input.limit } : {}),
      }),
  }),
  // hits the external Linear API — 'write' keeps read-only callers from driving it
  linearSearch: def({
    kind: 'query',
    input: z.object({ query: z.string() }),
    action: 'write',
    handler: (ctx, input) => ctx.issues.linearSearch(input.query),
  }),

  // ---- writes (scope-gated on their existing target via `target`) ----

  // agent-posted current state (activityNotes) — same nature as panelApply
  setState: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), text: z.string() }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.setState(input.id, input.text)),
  }),
  // agent-published human panel (todos/artifacts/deferred) — part of doing the work
  panelApply: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      op: z.enum([
        'todo-add',
        'todo-done',
        'todo-undone',
        'todo-remove',
        'todo-clear',
        'artifact-add',
        'artifact-remove',
        'deferred-add',
        'deferred-remove',
      ]),
      text: z.string().optional(),
      index: z.number().int().min(1).optional(),
      path: z.string().optional(),
      title: z.string().optional(),
      /** Extra file paths bundled with `path` into one artifact snapshot ([spec:SP-0fc9]). */
      extraPaths: z.array(z.string()).optional(),
    }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => {
        // Artifact ops route through the permanent-store paths ([spec:SP-0fc9]):
        // add pulls a snapshot from the owning daemon before the panel commit;
        // remove also deletes the snapshot dir.
        if (input.op === 'artifact-add') {
          if (!input.path) throw new Error('artifact-add requires a path')
          return ctx.issues.panelArtifactAdd(
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
          return ctx.issues.panelArtifactRemove(input.id, input.index)
        }
        return ctx.issues.panelApply(input.id, {
          op: input.op,
          text: input.text,
          index: input.index,
          path: input.path,
          title: input.title,
        } as never)
      }),
  }),
  // write — filing/decomposing is additive; scope gates writes to EXISTING issues,
  // not creation (no `target`).
  create: def({
    kind: 'mutation',
    input: z.object({
      repoPath: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      parentBranch: z.string().optional(),
      defaultAgent: z.string().optional(),
      defaultModel: z.string().optional(),
      defaultEffort: z.string().optional(),
      machineId: z.string().optional(),
      startNow: z.boolean(),
      linear: z
        .object({ id: z.string().optional(), identifier: z.string(), url: z.string() })
        .optional(),
      priority: z.number().int().min(0).max(4).optional(),
      type: IssueType.optional(),
      assignee: z.string().optional(),
      labels: z.array(z.string()).optional(),
      parentId: z.string().optional(),
      // Colour slot name [spec:SP-b4d1]; absent = no colour (slate flow).
      color: IssueColor.optional(),
      // #198: an agent opts a work item onto the human's top-level board with
      // `audience: 'human'`. `origin` is NOT accepted — it is derived from the
      // caller (operator vs constrained agent), so provenance cannot be forged.
      audience: z.enum(['human', 'agent']).optional(),
      mutationId: z.string().max(128).optional(),
    }),
    action: 'write',
    handler: async (ctx, input) => {
      // issues.create ALWAYS creates locally in P7b (creating INTO the hub needs
      // repo mapping — spec §2.2). A repoPath that exists only among the hub's
      // mirrored issues is detectable: reject it clearly instead of silently
      // filing a local issue against a repo this node doesn't have.
      // (hub check first: with no upstream issues this never touches the repo list —
      // the no-upstream-config inertness invariant, and test stubs stay happy.)
      if (
        ctx.deps.upstreamIssueRepoPaths().has(input.repoPath) &&
        !ctx.deps.repoPaths().includes(input.repoPath)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `repo ${input.repoPath} exists only on the hub — create the issue on the hub itself`,
        })
      }
      // #198 [spec:SP-a859]: two provenance axes, both derived HERE so they can't be forged.
      //  - origin  = WHO CREATED it: the unconstrained operator (scope 'all', i.e.
      //    the web UI / human) → 'human'; any constrained agent → 'agent'.
      //  - audience = WHO IT IS FOR: operator creates are always human-facing; an
      //    agent's creates default to 'agent' (internal working detail) and are
      //    opted onto the board only when the agent passes audience: 'human'.
      //
      // M6 / decision q6 (docs/agent-comms-target.html §11): an agent may create a
      // top-level issue with NO approval gate — it lands on the human board
      // immediately, flagged for attention (force audience:'human' + needsHuman).
      // Sub-issues (parentId set) stay internal by default; human creates unchanged.
      const isOperator = ctx.caller.capability.scope.kind === 'all'
      const origin: 'human' | 'agent' = isOperator ? 'human' : 'agent'
      const isAgentTopLevel = origin === 'agent' && !input.parentId
      const audience: 'human' | 'agent' = isOperator
        ? 'human'
        : isAgentTopLevel
          ? 'human'
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
        const created = await ctx.issues.createAndMaybeStart(
          { ...input, origin, audience, startedBySession },
          { spawnedBy: ctx.spawnProvenance() },
        )
        // Flag for attention so the human notices agent-filed top-level work.
        // Reuses needsHuman — no new column (S3 owns issues-table schema).
        if (isAgentTopLevel) {
          return ctx.issues.setNeedsHuman(
            created.id,
            'Agent created a top-level issue — review, claim, or reparent.',
            ctx.caller.capability.actorSessionId
              ? { askedBy: ctx.caller.capability.actorSessionId }
              : undefined,
          )
        }
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
  start: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      agentKind: z.string().optional(),
      forceUnknownModel: z.boolean().optional(),
    }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () =>
        ctx.issues.start(input.id, input.agentKind, {
          spawnedBy: ctx.spawnProvenance(),
          ...(input.forceUnknownModel ? { forceUnknownModel: true } : {}),
        }),
      ),
  }),
  update: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      patch: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        stage: IssueStage.optional(),
        parentBranch: z.string().optional(),
        defaultAgent: z.string().optional(),
        defaultModel: z.string().optional(),
        defaultEffort: z.string().optional(),
        machineId: z.string().nullable().optional(),
        archived: z.boolean().optional(),
        priority: z.number().int().min(0).max(4).optional(),
        type: IssueType.optional(),
        assignee: z.string().optional(),
        parentId: z.string().optional(),
        design: z.string().optional(),
        acceptance: z.string().optional(),
        notes: z.string().optional(),
        dueAt: z.string().optional(),
        deferUntil: z.string().optional(),
        closedReason: z.string().optional(),
        pinned: z.boolean().optional(),
        // Colour slot name [spec:SP-b4d1]; null clears back to the slate flow.
        color: IssueColor.nullable().optional(),
        estimateMin: z.number().int().optional(),
      }),
      mutationId: z.string().max(128).optional(),
    }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () =>
        ctx.withMutation(input.mutationId, () =>
          ctx.issues.update(input.id, input.patch, {
            actorSessionId: ctx.caller.capability.actorSessionId,
          }),
        ),
      ),
  }),
  // Agent self-organization (issue-as-workspace): re-home the calling session
  // onto an existing issue or a fresh sub-issue. sessionId comes from the daemon
  // relay context (the relay gate overwrites it) — never trusted from agent input.
  // Write, DELIBERATELY NOT scope-gated (no `target`): attaching is the session
  // RE-HOMING itself onto another issue — targeting outside the current subtree
  // is the whole point, so no --outside-scope needed. Not hub-forwarded
  // (sessions are local).
  attachSession: def({
    kind: 'mutation',
    input: z.object({
      sessionId: z.string(),
      targetId: z.string().optional(),
      confirmRehome: z.boolean().optional(),
      // #348 [spec:SP-a859]: no caller-supplied `origin` — provenance is derived
      // from the caller below, exactly like issues.create, so it cannot be forged.
      newSubissue: z.object({ title: z.string().min(1) }).optional(),
    }),
    action: 'write',
    handler: (ctx, input) => {
      const origin: 'human' | 'agent' =
        ctx.caller.capability.scope.kind === 'all' ? 'human' : 'agent'
      const { newSubissue, ...rest } = input
      return ctx.issues.attachSession(
        newSubissue ? { ...rest, newSubissue: { title: newSubissue.title, origin } } : { ...rest },
      )
    },
  }),
  archive: def({
    kind: 'mutation',
    input: byId,
    // Agent posture: allow in subtree; require --outside-scope confirmation
    // elsewhere. Archiving is reversible and no more destructive than close.
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.archive(input.id)),
  }),
  delete: def({
    kind: 'mutation',
    input: byId,
    action: 'manage',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.deleteIssue(input.id)),
  }),
  restore: def({
    kind: 'mutation',
    input: byId,
    action: 'manage',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.restoreIssue(input.id)),
  }),
  action: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), kind: z.enum(['rebase', 'pr', 'merge']) }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.action(input.id, input.kind)),
  }),
  // Write, not manage: heavily guarded (closed + merged + clean only), so a
  // closing agent may clean up after itself. Scope-gated like its siblings but
  // deliberately NOT issueWrite-forwarded (P7b write forwarding): cleanup acts on
  // LOCAL git state — it removes a worktree directory and deletes a branch via
  // THIS node's daemon. The hub cannot clean this node's worktree, and this node
  // must not delete another machine's. Hub-mirrored issues get a hard refusal
  // here instead of falling through to a misleading local 'unknown issue'.
  cleanup: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => {
      if (ctx.deps.isUpstreamIssue(input.id)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'cleanup is local-only: this issue is managed via the hub — run cleanup on the machine that owns its worktree',
        })
      }
      return ctx.issues.cleanup(input.id)
    },
  }),
  // Stop every session on the issue and free the worktree, keeping the branch
  // [spec:SP-9904]. Scope-gated like other issue writes (self/subtree free;
  // outside needs --outside-scope). Local-only — hub-mirrored issues refuse.
  stop: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      force: z.boolean().optional(),
    }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: async (ctx, input) => {
      if (ctx.deps.isUpstreamIssue(input.id)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'stop is local-only: this issue is managed via the hub — run stop on the machine that owns its sessions',
        })
      }
      if (!ctx.deps.stopIssueSessions) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'stopIssueSessions is not wired',
        })
      }
      const r = await ctx.deps.stopIssueSessions({
        issueId: input.id,
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
  // Write, not manage: builds/reset a dedicated integration worktree+branch only —
  // never touches child branches, the root checkout, or the parent branch. Spawns
  // nothing, so no confirm gate beyond the write role gate. Like cleanup,
  // deliberately NOT issueWrite-forwarded: integrate rebuilds a LOCAL integration
  // worktree/branch via THIS node's daemon. Hub-mirrored issues get a hard refusal.
  integrate: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => {
      if (ctx.deps.isUpstreamIssue(input.id)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'integrate is local-only: this issue is managed via the hub — run integrate on the machine that owns its worktrees',
        })
      }
      return ctx.issues.integrate(input.id)
    },
  }),
  addSession: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      agentKind: z.string().optional(),
      forceUnknownModel: z.boolean().optional(),
    }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () =>
        ctx.issues.addSession(input.id, input.agentKind, {
          spawnedBy: ctx.spawnProvenance(),
          ...(input.forceUnknownModel ? { forceUnknownModel: true } : {}),
        }),
      ),
  }),
  addShell: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () =>
        ctx.issues.addShell(input.id, { spawnedBy: ctx.spawnProvenance() }),
      ),
  }),
  applySuggestion: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.applySuggestion(input.id)),
  }),
  dismissSuggestion: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.dismissSuggestion(input.id)),
  }),
  refreshAssistant: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.refreshAssistant(input.id)),
  }),
  setLabels: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), labels: z.array(z.string()) }),
    action: 'manage',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => ctx.issues.setLabels(input.id, input.labels)),
  }),
  addComment: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      author: z.string(),
      body: z.string().min(1),
      mutationId: z.string().max(128).optional(),
    }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () =>
        ctx.withMutation(input.mutationId, () =>
          ctx.issues.addComment(input.id, input.author, input.body),
        ),
      ),
  }),
  depAdd: def({
    kind: 'mutation',
    input: z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }),
    action: 'write',
    scope: 'issue',
    target: (i) => i.fromId as string,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => ctx.issues.addDep(input.fromId, input.toId, input.type)),
  }),
  depRemove: def({
    kind: 'mutation',
    input: z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }),
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // Removing a mistaken edge is the inverse of the already-agent-safe depAdd.
    action: 'write',
    scope: 'issue',
    target: (i) => i.fromId as string,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => ctx.issues.removeDep(input.fromId, input.toId, input.type)),
  }),
  defer: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), until: z.string().nullable() }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.defer(input.id, input.until)),
  }),
  // Manual unsnooze (issue #133): ends a snooze and floats the issue back to the
  // top of WORK with the "Unsnoozed" tag (returned-from-defer), unlike defer(null)
  // which quietly clears it. Distinct route so it emits issue.unsnoozed cleanly.
  undefer: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.undefer(input.id)),
  }),
  // Mark an issue read (issue #124): stamp read_at = now, flipping derived `unread`.
  // Node-local read-tracking — deliberately NOT issueWrite (never hub-forwarded)
  // and 'read' authority only (reading marks read), despite being a mutation on
  // the wire.
  markRead: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), mutationId: z.string().max(128).optional() }),
    action: 'read',
    handler: (ctx, input) =>
      ctx.withMutation(input.mutationId, () => ctx.issues.markIssueRead(input.id)),
  }),
  // Mark an issue UNREAD again (issue #138): clear read_at, flipping derived
  // `unread` back to true. Node-local like markRead (NOT issueWrite / never
  // hub-forwarded) — read-tracking needs only 'read'.
  markUnread: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), mutationId: z.string().max(128).optional() }),
    action: 'read',
    handler: (ctx, input) =>
      ctx.withMutation(input.mutationId, () => ctx.issues.markIssueUnread(input.id)),
  }),
  setNeedsHuman: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      question: z.string().optional(),
      // Structured question metadata (issue #53): suggested answers rendered as
      // Tray chips + the asking session (defaults to the caller's own session).
      options: z.array(z.string().min(1)).max(20).optional(),
      askedBy: z.string().optional(),
    }),
    action: 'write',
    scope: 'issue',
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
      return ctx.issueWrite(input, () =>
        ctx.issues.setNeedsHuman(input.id, input.question ?? null, {
          ...(input.options ? { options: input.options } : {}),
          ...(askedBy ? { askedBy } : {}),
        }),
      )
    },
  }),
  /** Web-callable Tray answer (issue #53): deliver `answer` to the asking
   *  session via the shared answer_question matching path (live native menu →
   *  option digits; otherwise a chat message through the durable resumeAndSend),
   *  then clear needsHuman — ONLY after successful delivery, so a failed match
   *  or dead session never silently drops the question. */
  answerQuestion: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), answer: z.string().trim().min(1) }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, async () => {
        const issue = ctx.issues.getMeta(input.id)
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
        const r = await ctx.deps.answerSessionQuestion(issue.humanQuestionAskedBy, input.answer)
        if (!r.ok) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `answer not delivered: ${r.message}`,
          })
        }
        return { issue: ctx.issues.clearNeedsHuman(input.id), deliveredVia: r.via }
      }),
  }),
  clearNeedsHuman: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) => ctx.issueWrite(input, () => ctx.issues.clearNeedsHuman(input.id)),
  }),
  reparent: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), parentId: z.string().nullable() }),
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // This lets an agent repair its own planning hierarchy without recreating issues.
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => ctx.issues.reparent(input.id, input.parentId)),
  }),
  claim: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), assignee: z.string() }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => ctx.issues.claim(input.id, input.assignee)),
  }),
  /** Claim / set / clear the issue's designated coordinator session
   *  (docs/agent-comms-target.html §05 q1). Actionable issue-addressed mail
   *  prefers this session when it is live. Dangling-tolerant (no session FK). */
  setCoordinator: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      /** Explicit session id to set; null clears. Mutually exclusive with claim. */
      sessionId: z.string().nullable().optional(),
      /** When true, set coordinator to the calling session (actorSessionId). */
      claim: z.boolean().optional(),
    }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => {
        let sessionId: string | null
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
        return ctx.issues.setCoordinator(input.id, sessionId)
      }),
  }),
  close: def({
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      reason: z.string().optional(),
      mutationId: z.string().max(128).optional(),
    }),
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () =>
        ctx.withMutation(input.mutationId, () =>
          ctx.issues.close(input.id, input.reason, {
            actorSessionId: ctx.caller.capability.actorSessionId,
          }),
        ),
      ),
  }),
  supersede: def({
    kind: 'mutation',
    input: z.object({ oldId: z.string(), newId: z.string() }),
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // The mutated subject is oldId; newId remains a relation destination.
    action: 'write',
    scope: 'issue',
    target: (i) => i.oldId as string,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => ctx.issues.supersede(input.oldId, input.newId)),
  }),
  duplicate: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), canonicalId: z.string() }),
    // Agent posture: allow in subtree; require --outside-scope confirmation.
    // The mutated subject is id; canonicalId remains a relation destination.
    action: 'write',
    scope: 'issue',
    target: targetId,
    handler: (ctx, input) =>
      ctx.issueWrite(input, () => ctx.issues.duplicate(input.id, input.canonicalId)),
  }),

  // ---- agent mail (issue #103). Local-only (never hub-forwarded): message ids
  // and mailboxes live on this node.

  // Write, DELIBERATELY NOT scope-gated (no `target`): mail is an append-only
  // mailbox and addressing ANOTHER issue is the whole point of it — cross-issue
  // sends must not require --outside-scope. Treated like `create` (a write with
  // no existing-target issue), so the role gate still applies.
  mailSend: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), body: z.string().min(1) }),
    action: 'write',
    // Unified substrate (#237) [spec:SP-34d7]: the send persists a `messages`
    // row + delivery ledger and mirrors the legacy issue_messages row (same
    // id), so the wire shape (IssueMessageRow) is unchanged for the CLI/MCP.
    handler: (ctx, input) => {
      const send = ctx.deps.sendMessage
      if (!send) return ctx.issues.sendMail(input.id, ctx.mailIdentity(), input.body)
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
  mailInbox: def({
    kind: 'mutation',
    input: z.object({ id: z.string().optional() }).optional(),
    action: 'read',
    handler: (ctx, input) => {
      const id = ctx.mailOwnIssue(input?.id)
      // Only the recipient consumes unread status: an agent reading its own
      // mailbox (scope root = the issue). Operator/other-agent peeks must not
      // mark mail read, or delivery to the real recipient is suppressed.
      const markRead =
        ctx.caller.capability.scope.kind === 'subtree' &&
        ctx.issues.resolveRef(id) === ctx.caller.capability.scope.rootId
      return ctx.issues.mailInbox(id, { markRead })
    },
  }),
  // Write, scoped to the caller's own subtree; the target issue lives behind the
  // MESSAGE id, which a pure input extractor cannot resolve — `target` returns
  // undefined (documenting the intent, keeping the completeness checks total)
  // and the SAME shared check (#25) runs in the handler against the message's
  // issue — identical codes and messages. NOT hub-forwarded (message ids are
  // node-local).
  mailClaim: def({
    kind: 'mutation',
    input: z.object({ messageId: z.string() }),
    action: 'write',
    scope: 'issue',
    target: () => undefined,
    handler: (ctx, input) => {
      const msg = ctx.issues.mailMessage(input.messageId)
      if (!msg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `unknown mail message ${input.messageId}`,
        })
      }
      checkIssueAccess(ctx.caller, ctx.issues, 'mailClaim', 'write', msg.issueId)
      return ctx.issues.mailClaim(input.messageId, ctx.mailIdentity())
    },
  }),
  mailPending: def({
    kind: 'query',
    input: z.object({ id: z.string().optional() }).optional(),
    action: 'read',
    handler: (ctx, input) => ctx.issues.mailPending(ctx.mailOwnIssue(input?.id)),
  }),

  // ---- event subscriptions (event-subscriptions design, Phase B). Local-only
  // (subscriptions live on this node). add/remove/setEnabled operate on the
  // CALLER's own subscriptions (subscriber = the caller), so like mailSend they
  // are 'write' with no existing-issue target — the source-within-subtree /
  // own-row checks live in the handlers. list is a read of the caller's own rows.

  subscriptionAdd: def({
    kind: 'mutation',
    input: z.object({
      event: z.string().min(1),
      source: z.object({
        kind: z.enum(['relationship', 'issue', 'session']),
        ref: z.string().min(1),
      }),
      deliver: z
        .object({ nudge: z.boolean().optional(), notify: z.boolean().optional() })
        .optional(),
      // Operator-only (#129 Phase C): the Automations UI creates a subscription for an
      // explicit subscriber (which issue/session to notify). Ignored for constrained
      // agents, who always subscribe themselves via deriveSubscriber.
      subscriber: z.object({ kind: z.enum(['session', 'issue']), id: z.string() }).optional(),
    }),
    action: 'write',
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
      return ctx.issues.subscriptionAdd({
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
  subscriptionRemove: def({
    kind: 'mutation',
    input: byId,
    action: 'write',
    handler: (ctx, input) => {
      // Constrained callers may only remove their OWN subscriptions.
      if (ctx.caller.capability.scope.kind !== 'all') {
        const subscriber = ctx.deriveSubscriber()
        const owned = ctx.issues
          .subscriptionList({ subscriberId: subscriber.id })
          .some((s) => s.id === input.id)
        if (!owned) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'not allowed to remove a subscription you do not own',
          })
        }
      }
      return ctx.issues.subscriptionRemove(input.id)
    },
  }),
  /** Toggle a subscription on/off (#129 Phase C, Automations UI). Custom
   *  subscriptions only affect the additive dispatcher pass, so disabling one never
   *  touches the built-in handlers — safe and reversible. */
  subscriptionSetEnabled: def({
    kind: 'mutation',
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    action: 'write',
    handler: (ctx, input) => {
      // Constrained callers may only toggle their OWN subscriptions.
      if (ctx.caller.capability.scope.kind !== 'all') {
        const subscriber = ctx.deriveSubscriber()
        const owned = ctx.issues
          .subscriptionList({ subscriberId: subscriber.id })
          .some((s) => s.id === input.id)
        if (!owned) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'not allowed to toggle a subscription you do not own',
          })
        }
      }
      return ctx.issues.subscriptionSetEnabled(input.id, input.enabled)
    },
  }),
  subscriptionList: def({
    kind: 'query',
    // The one historical no-input proc: z.void() keeps `query()` (no args) valid
    // on every client while the registry contract still carries ONE schema.
    input: z.void(),
    action: 'read',
    handler: (ctx) => {
      // Operator sees every subscription; a constrained caller sees only its own.
      if (ctx.caller.capability.scope.kind === 'all') return ctx.issues.subscriptionList()
      const subscriber = ctx.deriveSubscriber()
      return ctx.issues.subscriptionList({ subscriberId: subscriber.id })
    },
  }),
} satisfies Record<IssueCommandName, AnyIssueCommandDef>

/** The one issues command registry — namespace + defs (see module doc). */
export const issueRegistry = defineCommands('issues', defs)

export type IssueRegistryDefs = typeof issueRegistry.defs

/** The target EXISTING-issue id a command mutates, per its registry definition —
 *  the replacement for indexing the old SCOPED_TARGET map by proc name (viaHub
 *  forwarding + upstream outbox folding read through this). */
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
  issues: IssueService,
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
        ? (issues.getMeta(caller.capability.scope.rootId)?.repoPath ?? undefined)
        : undefined
    targetId =
      typeof rawTarget === 'string' ? issues.resolveRef(rawTarget, scopeRepoPath) : rawTarget
  }
  // The shared decision + throw shape (#25) — also used by the in-handler mailClaim gate.
  checkIssueAccess(caller, issues, name, def.action, targetId)
}

/**
 * The in-process command surface derived from the registry: runs one command as
 * `caller` with the full router-equivalent pipeline (guard on the RAW input,
 * zod parse with the SAME schema the router mounts, then the handler), serving
 * the daemon relay gate and the in-process MCP. Replaces IssueCommandService's
 * 60-odd hand-mirrored methods and its Proxy adapters (callerFor/asIssueTrpc).
 */
export class IssueCommandDispatcher {
  constructor(private readonly deps: IssueCommandDeps) {}

  /** Execute one ALREADY-guarded, ALREADY-parsed command (the tRPC path: the
   *  derived middleware guarded, tRPC parsed `def.input`). */
  run<D extends AnyIssueCommandDef>(
    caller: IssueCaller,
    name: string,
    def: D,
    input: z.infer<D['input']>,
  ): ReturnType<D['handler']> {
    return def.handler(
      new IssueCommandCtx(this.deps, caller, name, def.target),
      input,
    ) as ReturnType<D['handler']>
  }

  /**
   * Run one relayed/MCP command from RAW input: guard, parse, handle — the
   * exact pipeline the derived router applies. Returns undefined for an unknown
   * router/proc so callers can shape their own "no such procedure" reply.
   */
  dispatch(
    caller: IssueCaller,
    router: string,
    proc: string,
    rawInput: unknown,
  ): Promise<unknown> | undefined {
    if (router === 'repos') {
      if (proc !== 'inferFromPath') return undefined
      return Promise.resolve().then(() => {
        const input = z.object({ path: z.string() }).parse(rawInput)
        return { repoPath: this.deps.inferRepoFromPath(input.path) ?? null }
      })
    }
    if (router !== 'issues' || !Object.hasOwn(issueRegistry.defs, proc)) return undefined
    const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[
      proc
    ] as AnyIssueCommandDef
    return Promise.resolve().then(() => {
      guardIssueCommand(caller, this.deps.issues(), proc, def, rawInput)
      const input: unknown = def.input.parse(rawInput)
      return this.run(caller, proc, def, input)
    })
  }

  /**
   * IssueTrpc-shaped client (`.<router>.<proc>.mutate|query(input)`) for the
   * in-process MCP / shared issue command table — a plain object built over the
   * registry's key set (typed derivation), not a Proxy: an unknown proc is a
   * compile-time hole, not a runtime maybe.
   */
  asIssueTrpc(capability: Capability, overrideScope?: boolean): IssueTrpc {
    const caller: IssueCaller = { capability, ...(overrideScope ? { overrideScope } : {}) }
    const proc = (router: 'issues' | 'repos', name: string): IssueProc => {
      const call = (input?: unknown): Promise<unknown> => {
        const result = this.dispatch(caller, router, name, input)
        if (result === undefined) throw new Error(`no such issue procedure: ${router}.${name}`)
        return result
      }
      return { query: call, mutate: call }
    }
    const issues = Object.fromEntries(
      ISSUE_COMMAND_NAMES.map((name) => [name, proc('issues', name)]),
    ) as Record<IssueCommandName, IssueProc>
    // The in-process surface never served the specs router (pspec rides the
    // daemon relay / HTTP only) — keep the historical "no such procedure" throw.
    const specProc = (name: string): IssueProc => {
      const call = (): Promise<unknown> => {
        throw new Error(`no such issue procedure: specs.${name}`)
      }
      return { query: call, mutate: call }
    }
    const specs = Object.fromEntries(
      ['list', 'get', 'create', 'save', 'remove', 'search'].map((n) => [n, specProc(n)]),
    )
    // Like specs, the in-process surface doesn't serve the lock router
    // [spec:SP-85d1] — locks ride the daemon relay / HTTP (podium lock CLI).
    const lockProc = (name: string): IssueProc => {
      const call = (): Promise<unknown> => {
        throw new Error(`no such issue procedure: lock.${name}`)
      }
      return { query: call, mutate: call }
    }
    const lock = Object.fromEntries(
      ['acquire', 'release', 'renew', 'status', 'steal'].map((n) => [n, lockProc(n)]),
    )
    return {
      issues,
      repos: { inferFromPath: proc('repos', 'inferFromPath') },
      specs,
      lock,
    } as IssueTrpc
  }
}
