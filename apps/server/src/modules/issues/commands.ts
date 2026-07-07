import { IssueStage, IssueType, type SessionMeta } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  authorize,
  type Capability,
  checkIssueAccess,
  PROC_ACTION,
  SCOPED_TARGET,
} from '../../issue-authz'
import type { IssueTrpc } from '../../issue-client'
import type { IssueService } from '../../issues'

/** Who is calling (authz identity) — the same pair the router Context carries. */
export interface IssueCaller {
  capability: Capability
  /** The agent passed --outside-scope: a knowing write outside its subtree. */
  overrideScope?: boolean
}

export interface IssueCommandDeps {
  /** Lazy — the IssueService is assigned late in the composition root. */
  issues(): IssueService
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
}

// ---------------------------------------------------------------------------
// Input schemas — the single source for BOTH entry paths: the tRPC router mounts
// them via `.input(issueInputs.<proc>)` (HTTP/operator path), and invoke() parses
// relayed/MCP input with the same schema, so wire validation cannot drift.
// ---------------------------------------------------------------------------

const repoScoped = z.object({ repoPath: z.string().optional() })
const byId = z.object({ id: z.string() })

export const issueInputs = {
  list: repoScoped,
  prime: repoScoped.optional(),
  ready: repoScoped,
  blocked: repoScoped,
  graph: repoScoped,
  epicStatus: byId,
  children: z.object({ id: z.string(), recursive: z.boolean().optional() }),
  tree: byId,
  setState: z.object({ id: z.string(), text: z.string() }),
  panelApply: z.object({
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
  }),
  depReport: z.object({ id: z.string().optional(), repoPath: z.string().optional() }),
  closeEligibleEpics: repoScoped,
  findDuplicates: z.object({ repoPath: z.string().optional(), threshold: z.number().optional() }),
  stale: z.object({ repoPath: z.string().optional(), days: z.number().optional() }),
  lint: repoScoped,
  doctor: repoScoped,
  preflight: repoScoped,
  search: z.object({
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
  count: repoScoped,
  stats: repoScoped,
  orphans: z.object({ repoPath: z.string() }),
  get: byId,
  events: z.object({
    since: z.number().int().min(0).default(0),
    kinds: z.array(z.string()).optional(),
    repoPath: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  create: z.object({
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
    mutationId: z.string().max(128).optional(),
  }),
  start: z.object({ id: z.string(), agentKind: z.string().optional() }),
  update: z.object({
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
      estimateMin: z.number().int().optional(),
    }),
    mutationId: z.string().max(128).optional(),
  }),
  attachSession: z.object({
    sessionId: z.string(),
    targetId: z.string().optional(),
    newSubissue: z
      .object({ title: z.string().min(1), origin: z.enum(['human', 'agent']).optional() })
      .optional(),
  }),
  archive: byId,
  delete: byId,
  action: z.object({ id: z.string(), kind: z.enum(['rebase', 'pr', 'merge']) }),
  cleanup: byId,
  integrate: byId,
  addSession: z.object({ id: z.string(), agentKind: z.string().optional() }),
  addShell: byId,
  applySuggestion: byId,
  dismissSuggestion: byId,
  refreshAssistant: byId,
  setLabels: z.object({ id: z.string(), labels: z.array(z.string()) }),
  addComment: z.object({
    id: z.string(),
    author: z.string(),
    body: z.string().min(1),
    mutationId: z.string().max(128).optional(),
  }),
  mailSend: z.object({ id: z.string(), body: z.string().min(1) }),
  mailInbox: z.object({ id: z.string().optional() }).optional(),
  mailClaim: z.object({ messageId: z.string() }),
  mailPending: z.object({ id: z.string().optional() }).optional(),
  depAdd: z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }),
  depRemove: z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }),
  defer: z.object({ id: z.string(), until: z.string().nullable() }),
  undefer: byId,
  markRead: z.object({ id: z.string(), mutationId: z.string().max(128).optional() }),
  setNeedsHuman: z.object({ id: z.string(), question: z.string().optional() }),
  clearNeedsHuman: byId,
  reparent: z.object({ id: z.string(), parentId: z.string().nullable() }),
  claim: z.object({ id: z.string(), assignee: z.string() }),
  close: z.object({
    id: z.string(),
    reason: z.string().optional(),
    mutationId: z.string().max(128).optional(),
  }),
  supersede: z.object({ oldId: z.string(), newId: z.string() }),
  duplicate: z.object({ id: z.string(), canonicalId: z.string() }),
  linearSearch: z.object({ query: z.string() }),
  subscriptionAdd: z.object({
    event: z.string().min(1),
    source: z.object({
      kind: z.enum(['relationship', 'issue', 'session']),
      ref: z.string().min(1),
    }),
    deliver: z.object({ nudge: z.boolean().optional(), notify: z.boolean().optional() }).optional(),
  }),
  subscriptionRemove: byId,
} as const

type In<K extends keyof typeof issueInputs> = z.infer<(typeof issueInputs)[K]>

/**
 * The in-process issue command surface (issue #13 Phase 2 step 4): every issues
 * proc body lives HERE, backed directly by the services — the tRPC router mounts
 * these same methods for the HTTP/operator path, and {@link invoke} serves the
 * daemon relay + in-process MCP with the SAME authorization the router middleware
 * applies (checkIssueAccess over PROC_ACTION/SCOPED_TARGET, the viaHub forwarding
 * branch, withMutation idempotency). This replaces the makeIssueCaller /
 * callerAsIssueTrpc detour through appRouter.createCaller, killing the
 * relay↔router runtime cycle: relay-side code never touches the router again.
 */
export class IssueCommandService {
  constructor(private readonly deps: IssueCommandDeps) {}

  private issues(): IssueService {
    return this.deps.issues()
  }

  // ---- shared authz/forwarding helpers (moved verbatim from router.ts) ----

  /**
   * The same two-gate check the router's issueCapabilityGuard middleware runs
   * (role gate ⇒ FORBIDDEN; out-of-subtree write on an existing target ⇒
   * PRECONDITION_FAILED unless overridden). Run on the RAW input BEFORE zod
   * parsing, mirroring middleware-before-input ordering.
   */
  guard(caller: IssueCaller, proc: string, rawInput: unknown): void {
    const action = PROC_ACTION[proc] ?? 'read'
    const extract = caller.capability.scope.kind !== 'all' ? SCOPED_TARGET[proc] : undefined
    let targetId: string | undefined
    if (extract) {
      const rawTarget = extract((rawInput ?? {}) as Record<string, unknown>)
      // Resolve display refs (#seq) to the internal id BEFORE the subtree check —
      // scope.rootId is an internal id, so comparing the raw ref would
      // false-negative on the agent's own bound issue.
      targetId = typeof rawTarget === 'string' ? this.issues().resolveRef(rawTarget) : rawTarget
    }
    checkIssueAccess(caller, this.issues(), proc, action, targetId)
  }

  /**
   * viaHub write forwarding (docs/spec/node-hub-issues.md §2.2): a mutation whose
   * target is a hub-mirrored issue is handed to the upstream forwarder instead of
   * the local IssueService — `{ queued: true }` when the hub is unreachable, the
   * hub's own result when it is. Only the unconstrained operator may act on hub
   * issues; node-side agents/assistants never do (§2.3).
   */
  private issueWrite<R>(
    caller: IssueCaller,
    proc: string,
    input: Record<string, unknown>,
    local: () => R,
  ): R | Promise<Awaited<R> | { queued: true }> {
    const target = SCOPED_TARGET[proc]?.(input)
    if (typeof target === 'string' && this.deps.isUpstreamIssue(target)) {
      if (caller.capability.scope.kind !== 'all') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'issue is managed via the hub — agents cannot act on hub issues from this node',
        })
      }
      // The hub runs the same router, so its result IS this proc's result shape —
      // plus the offline `{ queued: true }` outcome (spec §2.2).
      return this.deps.forwardIssueMutation(proc, input) as Promise<Awaited<R> | { queued: true }>
    }
    return local()
  }

  /** Agent-mail sender/claimer identity: the caller's bound issue (`issue:#<seq>`)
   *  for a subtree-scoped agent, else 'operator'. */
  private mailIdentity(caller: IssueCaller): string {
    if (caller.capability.scope.kind === 'subtree') {
      const me = this.issues().get(caller.capability.scope.rootId)
      if (me) return `issue:#${me.seq}`
    }
    return 'operator'
  }

  /** Resolve an omitted mail issue ref to the caller's own bound issue (capability rootId). */
  private mailOwnIssue(caller: IssueCaller, id?: string): string {
    if (id) return id
    if (caller.capability.scope.kind === 'subtree') return caller.capability.scope.rootId
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'no issue bound to this caller; pass an issue id',
    })
  }

  /** The subscriber a subscription defaults to: the CALLER. A relayed agent's own
   *  session (capability.actorSessionId) when the call is session-bound, else its
   *  subtree root issue. The operator (scope 'all', no actor) has no implicit
   *  subscriber — it manages subscriptions via the Automations UI (Phase C). */
  private deriveSubscriber(caller: IssueCaller): { kind: 'session' | 'issue'; id: string } {
    if (caller.capability.actorSessionId) {
      return { kind: 'session', id: caller.capability.actorSessionId }
    }
    if (caller.capability.scope.kind === 'subtree') {
      return { kind: 'issue', id: caller.capability.scope.rootId }
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
  private assertSourceInSubtree(
    caller: IssueCaller,
    source: { kind: 'relationship' | 'issue' | 'session'; ref: string },
  ): void {
    if (source.kind === 'issue') {
      const id = this.issues().resolveRef(source.ref)
      const decision = authorize(
        caller.capability,
        'write',
        { id, ancestorIds: this.issues().ancestorIds(id) },
        { override: caller.overrideScope },
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
    if (source.ref === caller.capability.actorSessionId) return
    const bound = this.deps.listSessions().find((s) => s.sessionId === source.ref)?.issueId
    const ok =
      bound != null &&
      authorize(caller.capability, 'write', {
        id: bound,
        ancestorIds: this.issues().ancestorIds(bound),
      }) === 'allow'
    if (!ok) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'not allowed to watch a session outside your subtree',
      })
    }
  }

  // ---- reads ----

  list(_c: IssueCaller, input: In<'list'>) {
    return this.issues().list(input.repoPath)
  }
  prime(c: IssueCaller, input: In<'prime'>) {
    return this.issues().prime({
      repoPath: input?.repoPath,
      boundIssueId: c.capability.scope.kind === 'subtree' ? c.capability.scope.rootId : null,
    })
  }
  ready(_c: IssueCaller, input: In<'ready'>) {
    return this.issues().readyList(input.repoPath)
  }
  blocked(_c: IssueCaller, input: In<'blocked'>) {
    return this.issues().blockedList(input.repoPath)
  }
  graph(_c: IssueCaller, input: In<'graph'>) {
    return this.issues().graph(input.repoPath)
  }
  epicStatus(_c: IssueCaller, input: In<'epicStatus'>) {
    return this.issues().epicStatus(input.id)
  }
  children(_c: IssueCaller, input: In<'children'>) {
    return this.issues().children(input.id, input.recursive ?? false)
  }
  tree(_c: IssueCaller, input: In<'tree'>) {
    return this.issues().tree(input.id)
  }
  depReport(_c: IssueCaller, input: In<'depReport'>) {
    return this.issues().depReport(input)
  }
  closeEligibleEpics(_c: IssueCaller, input: In<'closeEligibleEpics'>) {
    return this.issues().closeEligibleEpics(input.repoPath)
  }
  findDuplicates(_c: IssueCaller, input: In<'findDuplicates'>) {
    return this.issues().findDuplicates(input.repoPath, input.threshold)
  }
  stale(_c: IssueCaller, input: In<'stale'>) {
    return this.issues().staleList(input.repoPath, input.days)
  }
  lint(_c: IssueCaller, input: In<'lint'>) {
    return this.issues().lint(input.repoPath)
  }
  doctor(_c: IssueCaller, input: In<'doctor'>) {
    return this.issues().doctor(input.repoPath)
  }
  preflight(_c: IssueCaller, input: In<'preflight'>) {
    return this.issues().preflight(input.repoPath)
  }
  search(_c: IssueCaller, input: In<'search'>) {
    return this.issues().search(input)
  }
  count(_c: IssueCaller, input: In<'count'>) {
    return this.issues().count(input.repoPath)
  }
  stats(_c: IssueCaller, input: In<'stats'>) {
    return this.issues().stats(input.repoPath)
  }
  orphans(_c: IssueCaller, input: In<'orphans'>) {
    return this.issues().orphans(input.repoPath)
  }
  get(_c: IssueCaller, input: In<'get'>) {
    return this.issues().get(input.id)
  }
  events(_c: IssueCaller, input: In<'events'>) {
    return this.issues().listEvents(input.since, {
      ...(input.kinds ? { kinds: input.kinds } : {}),
      ...(input.repoPath ? { repoPath: input.repoPath } : {}),
      ...(input.limit != null ? { limit: input.limit } : {}),
    })
  }
  linearSearch(_c: IssueCaller, input: In<'linearSearch'>) {
    return this.issues().linearSearch(input.query)
  }

  // ---- writes ----

  setState(c: IssueCaller, input: In<'setState'>) {
    return this.issueWrite(c, 'setState', input, () => this.issues().setState(input.id, input.text))
  }
  panelApply(c: IssueCaller, input: In<'panelApply'>) {
    return this.issueWrite(c, 'panelApply', input, () =>
      this.issues().panelApply(input.id, {
        op: input.op,
        text: input.text,
        index: input.index,
        path: input.path,
        title: input.title,
      } as never),
    )
  }
  create(c: IssueCaller, input: In<'create'>) {
    // issues.create ALWAYS creates locally in P7b (creating INTO the hub needs
    // repo mapping — spec §2.2). A repoPath that exists only among the hub's
    // mirrored issues is detectable: reject it clearly instead of silently
    // filing a local issue against a repo this node doesn't have.
    // (hub check first: with no upstream issues this never touches the repo list —
    // the no-upstream-config inertness invariant, and test stubs stay happy.)
    if (
      this.deps.upstreamIssueRepoPaths().has(input.repoPath) &&
      !this.deps.repoPaths().includes(input.repoPath)
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `repo ${input.repoPath} exists only on the hub — create the issue on the hub itself`,
      })
    }
    return this.deps.withMutation(input.mutationId, 'issues.create', () =>
      this.issues().createAndMaybeStart(input),
    )
  }
  start(c: IssueCaller, input: In<'start'>) {
    return this.issueWrite(c, 'start', input, () => this.issues().start(input.id, input.agentKind))
  }
  update(c: IssueCaller, input: In<'update'>) {
    return this.issueWrite(c, 'update', input, () =>
      this.deps.withMutation(input.mutationId, 'issues.update', () =>
        this.issues().update(input.id, input.patch, {
          actorSessionId: c.capability.actorSessionId,
        }),
      ),
    )
  }
  // Agent self-organization (issue-as-workspace): re-home the calling session
  // onto an existing issue or a fresh sub-issue. sessionId comes from the daemon
  // relay context (the relay gate overwrites it) — never trusted from agent input.
  // Deliberately NOT scope-gated (see PROC_ACTION note) and not hub-forwarded
  // (sessions are local).
  attachSession(_c: IssueCaller, input: In<'attachSession'>) {
    return this.issues().attachSession(input)
  }
  archive(c: IssueCaller, input: In<'archive'>) {
    return this.issueWrite(c, 'archive', input, () => this.issues().archive(input.id))
  }
  delete(c: IssueCaller, input: In<'delete'>) {
    return this.issueWrite(c, 'delete', input, () => this.issues().delete(input.id))
  }
  action(c: IssueCaller, input: In<'action'>) {
    return this.issueWrite(c, 'action', input, () => this.issues().action(input.id, input.kind))
  }
  // Deliberately NOT issueWrite-forwarded (P7b write forwarding): cleanup acts on
  // LOCAL git state — it removes a worktree directory and deletes a branch via
  // THIS node's daemon. The hub cannot clean this node's worktree, and this node
  // must not delete another machine's. Hub-mirrored issues get a hard refusal
  // here instead of falling through to a misleading local 'unknown issue'.
  cleanup(_c: IssueCaller, input: In<'cleanup'>) {
    if (this.deps.isUpstreamIssue(input.id)) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'cleanup is local-only: this issue is managed via the hub — run cleanup on the machine that owns its worktree',
      })
    }
    return this.issues().cleanup(input.id)
  }
  // Like cleanup, deliberately NOT issueWrite-forwarded: integrate rebuilds a
  // LOCAL integration worktree/branch via THIS node's daemon — the hub cannot
  // rebuild this node's worktree. Hub-mirrored issues get a hard refusal.
  // Spawns nothing, so it is not confirmed-gated beyond the write role gate.
  integrate(_c: IssueCaller, input: In<'integrate'>) {
    if (this.deps.isUpstreamIssue(input.id)) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'integrate is local-only: this issue is managed via the hub — run integrate on the machine that owns its worktrees',
      })
    }
    return this.issues().integrate(input.id)
  }
  addSession(c: IssueCaller, input: In<'addSession'>) {
    return this.issueWrite(c, 'addSession', input, () =>
      this.issues().addSession(input.id, input.agentKind),
    )
  }
  addShell(c: IssueCaller, input: In<'addShell'>) {
    return this.issueWrite(c, 'addShell', input, () => this.issues().addShell(input.id))
  }
  applySuggestion(c: IssueCaller, input: In<'applySuggestion'>) {
    return this.issueWrite(c, 'applySuggestion', input, () =>
      this.issues().applySuggestion(input.id),
    )
  }
  dismissSuggestion(c: IssueCaller, input: In<'dismissSuggestion'>) {
    return this.issueWrite(c, 'dismissSuggestion', input, () =>
      this.issues().dismissSuggestion(input.id),
    )
  }
  refreshAssistant(c: IssueCaller, input: In<'refreshAssistant'>) {
    return this.issueWrite(c, 'refreshAssistant', input, () =>
      this.issues().refreshAssistant(input.id),
    )
  }
  setLabels(c: IssueCaller, input: In<'setLabels'>) {
    return this.issueWrite(c, 'setLabels', input, () =>
      this.issues().setLabels(input.id, input.labels),
    )
  }
  addComment(c: IssueCaller, input: In<'addComment'>) {
    return this.issueWrite(c, 'addComment', input, () =>
      this.deps.withMutation(input.mutationId, 'issues.addComment', () =>
        this.issues().addComment(input.id, input.author, input.body),
      ),
    )
  }
  depAdd(c: IssueCaller, input: In<'depAdd'>) {
    return this.issueWrite(c, 'depAdd', input, () =>
      this.issues().addDep(input.fromId, input.toId, input.type),
    )
  }
  depRemove(c: IssueCaller, input: In<'depRemove'>) {
    return this.issueWrite(c, 'depRemove', input, () =>
      this.issues().removeDep(input.fromId, input.toId, input.type),
    )
  }
  defer(c: IssueCaller, input: In<'defer'>) {
    return this.issueWrite(c, 'defer', input, () => this.issues().defer(input.id, input.until))
  }
  // Manual unsnooze (issue #133): ends a snooze and floats the issue back to the
  // top of WORK with the "Unsnoozed" tag (returned-from-defer), unlike defer(null)
  // which quietly clears it. Distinct route so it emits issue.unsnoozed cleanly.
  undefer(c: IssueCaller, input: In<'undefer'>) {
    return this.issueWrite(c, 'undefer', input, () => this.issues().undefer(input.id))
  }
  // Mark an issue read (issue #124): stamp read_at = now, flipping derived `unread`.
  // Node-local read-tracking — deliberately NOT issueWrite (never hub-forwarded) and
  // unlisted in PROC_ACTION, so it needs only 'read' authority (reading marks read).
  markRead(_c: IssueCaller, input: In<'markRead'>) {
    return this.deps.withMutation(input.mutationId, 'issues.markRead', () =>
      this.issues().markIssueRead(input.id),
    )
  }
  setNeedsHuman(c: IssueCaller, input: In<'setNeedsHuman'>) {
    return this.issueWrite(c, 'setNeedsHuman', input, () =>
      this.issues().setNeedsHuman(input.id, input.question ?? null),
    )
  }
  clearNeedsHuman(c: IssueCaller, input: In<'clearNeedsHuman'>) {
    return this.issueWrite(c, 'clearNeedsHuman', input, () =>
      this.issues().clearNeedsHuman(input.id),
    )
  }
  reparent(c: IssueCaller, input: In<'reparent'>) {
    return this.issueWrite(c, 'reparent', input, () =>
      this.issues().reparent(input.id, input.parentId),
    )
  }
  claim(c: IssueCaller, input: In<'claim'>) {
    return this.issueWrite(c, 'claim', input, () => this.issues().claim(input.id, input.assignee))
  }
  close(c: IssueCaller, input: In<'close'>) {
    return this.issueWrite(c, 'close', input, () =>
      this.deps.withMutation(input.mutationId, 'issues.close', () =>
        this.issues().close(input.id, input.reason, {
          actorSessionId: c.capability.actorSessionId,
        }),
      ),
    )
  }
  supersede(c: IssueCaller, input: In<'supersede'>) {
    return this.issueWrite(c, 'supersede', input, () =>
      this.issues().supersede(input.oldId, input.newId),
    )
  }
  duplicate(c: IssueCaller, input: In<'duplicate'>) {
    return this.issueWrite(c, 'duplicate', input, () =>
      this.issues().duplicate(input.id, input.canonicalId),
    )
  }

  // ---- agent mail (issue #103). Local-only (never hub-forwarded): message ids
  // and mailboxes live on this node. mailSend is deliberately cross-scope (see
  // PROC_ACTION comment); mailClaim enforces scope in-proc (see SCOPED_TARGET).

  mailSend(c: IssueCaller, input: In<'mailSend'>) {
    return this.issues().sendMail(input.id, this.mailIdentity(c), input.body)
  }
  // A mutation (listing marks the returned unread messages read), but authz-wise
  // a 'read' — mailbox bookkeeping, not issue mutation.
  mailInbox(c: IssueCaller, input: In<'mailInbox'>) {
    const id = this.mailOwnIssue(c, input?.id)
    // Only the recipient consumes unread status: an agent reading its own
    // mailbox (scope root = the issue). Operator/other-agent peeks must not
    // mark mail read, or delivery to the real recipient is suppressed.
    const markRead =
      c.capability.scope.kind === 'subtree' &&
      this.issues().resolveRef(id) === c.capability.scope.rootId
    return this.issues().mailInbox(id, { markRead })
  }
  mailClaim(c: IssueCaller, input: In<'mailClaim'>) {
    const msg = this.issues().mailMessage(input.messageId)
    if (!msg) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `unknown mail message ${input.messageId}`,
      })
    }
    // Proc-level scope gate: the guard cannot resolve message→issue from the
    // input (SCOPED_TARGET.mailClaim), so the SAME shared check (#25) runs
    // here against the message's issue — identical codes and messages.
    checkIssueAccess(c, this.issues(), 'mailClaim', 'write', msg.issueId)
    return this.issues().mailClaim(input.messageId, this.mailIdentity(c))
  }
  mailPending(c: IssueCaller, input: In<'mailPending'>) {
    return this.issues().mailPending(this.mailOwnIssue(c, input?.id))
  }

  // ---- event subscriptions (event-subscriptions design, Phase B). Local-only
  // (subscriptions live on this node). The subscriber defaults to the CALLER — a
  // relayed agent's own session (capability.actorSessionId) or, if the call is
  // not session-bound, its subtree root issue. A constrained caller may only watch
  // a source inside its subtree; the operator is unconstrained. Custom origin.

  subscriptionAdd(c: IssueCaller, input: In<'subscriptionAdd'>) {
    const subscriber = this.deriveSubscriber(c)
    // Constrained callers may only watch a source WITHIN their subtree; the
    // operator (scope 'all') is unconstrained. Relationship sources resolve
    // dynamically against the subscriber's own subtree, so they are always in-scope.
    if (c.capability.scope.kind !== 'all' && input.source.kind !== 'relationship') {
      this.assertSourceInSubtree(c, input.source)
    }
    return this.issues().subscriptionAdd({
      subscriberKind: subscriber.kind,
      subscriberId: subscriber.id,
      event: input.event,
      sourceKind: input.source.kind,
      sourceRef: input.source.ref,
      ...(input.deliver?.nudge != null ? { deliverNudge: input.deliver.nudge } : {}),
      ...(input.deliver?.notify != null ? { deliverNotify: input.deliver.notify } : {}),
    })
  }
  subscriptionRemove(c: IssueCaller, input: In<'subscriptionRemove'>) {
    // Constrained callers may only remove their OWN subscriptions.
    if (c.capability.scope.kind !== 'all') {
      const subscriber = this.deriveSubscriber(c)
      const owned = this.issues()
        .subscriptionList({ subscriberId: subscriber.id })
        .some((s) => s.id === input.id)
      if (!owned) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'not allowed to remove a subscription you do not own',
        })
      }
    }
    return this.issues().subscriptionRemove(input.id)
  }
  subscriptionList(c: IssueCaller) {
    // Operator sees every subscription; a constrained caller sees only its own.
    if (c.capability.scope.kind === 'all') return this.issues().subscriptionList()
    const subscriber = this.deriveSubscriber(c)
    return this.issues().subscriptionList({ subscriberId: subscriber.id })
  }

  // ---- in-process entry for the daemon relay + MCP ----

  /**
   * Run one proc as `caller`, with the full router-equivalent pipeline: the
   * capability guard on the RAW input (middleware ordering), then zod parse with
   * the SAME schema the router mounts, then the proc body. Returns undefined for
   * an unknown proc so callers can shape their own "no such procedure" reply.
   */
  invoke(
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
    if (!this.has(router, proc)) return undefined
    const method = (this as unknown as Record<string, unknown>)[proc]
    return Promise.resolve().then(() => {
      this.guard(caller, proc, rawInput)
      const schema = (issueInputs as Record<string, z.ZodTypeAny | undefined>)[proc]
      const input = schema ? schema.parse(rawInput) : undefined
      return (method as (c: IssueCaller, i: unknown) => unknown).call(this, caller, input)
    })
  }

  /** Whether `router.proc` is a servable procedure (no side effects). */
  has(router: string, proc: string): boolean {
    if (router === 'repos') return proc === 'inferFromPath'
    if (router !== 'issues') return false
    if (proc === 'subscriptionList') return true
    return (
      Object.hasOwn(issueInputs, proc) &&
      typeof (this as unknown as Record<string, unknown>)[proc] === 'function'
    )
  }

  /**
   * The `{ [router]: { [proc]: fn } }` caller shape the relay gate indexes
   * (unknown procs read as undefined → the gate's own "no such procedure" reply).
   */
  callerFor(
    capability: Capability,
    overrideScope?: boolean,
  ): { [router: string]: Record<string, (i: unknown) => Promise<unknown>> | undefined } {
    const caller: IssueCaller = { capability, ...(overrideScope ? { overrideScope } : {}) }

    return new Proxy(
      {},
      {
        get: (_t, router) => {
          if (typeof router !== 'string') return undefined
          return new Proxy(
            {},
            {
              get: (_t2, proc) => {
                if (typeof proc !== 'string' || !this.has(router, proc)) return undefined
                return (input: unknown) =>
                  this.invoke(caller, router, proc, input) as Promise<unknown>
              },
            },
          )
        },
      },
    ) as never
  }

  /** IssueTrpc-shaped client (`.<router>.<proc>.mutate|query(input)`) for the
   *  in-process MCP / shared issue command registry — replaces callerAsIssueTrpc
   *  over appRouter.createCaller. */
  asIssueTrpc(capability: Capability, overrideScope?: boolean): IssueTrpc {
    const caller: IssueCaller = { capability, ...(overrideScope ? { overrideScope } : {}) }

    const procProxy = (router: string) =>
      new Proxy(
        {},
        {
          get: (_t, proc) => {
            if (typeof proc !== 'string') return undefined
            const call = (input: unknown) => {
              const result = this.invoke(caller, router, proc, input)
              if (result === undefined) {
                throw new Error(`no such issue procedure: ${router}.${proc}`)
              }
              return result
            }
            return { mutate: call, query: call }
          },
        },
      )
    return new Proxy(
      {},
      { get: (_t, router) => (typeof router === 'string' ? procProxy(router) : undefined) },
    ) as unknown as IssueTrpc
  }
}
