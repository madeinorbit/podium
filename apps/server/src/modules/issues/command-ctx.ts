/**
 * THE PER-CALL EXECUTION CONTEXT for issue commands, and the injected surface it
 * is built over (POD-1398).
 *
 * SPLIT OUT OF `registry.ts`, which shipped this class, the dispatcher AND the
 * command table in one file. The god-object audit refuses that arrangement by
 * name: "a table that also ships an object is two things in one file, and the
 * object is the half nobody reviewed" (scripts/audit-god-objects.ts). The seam
 * the code already implied is the dependency order — CONTEXT, then the TABLE of
 * handlers written against it, then the DISPATCHER that runs one. Each half now
 * has its own file in that order, so the graph is acyclic at runtime and each
 * can be read without the other two.
 *
 * What lives here is everything a HANDLER is handed and nothing about how a
 * handler is chosen:
 *
 *   - {@link IssueCaller}, the authz identity every transport carries;
 *   - {@link IssueCommandDeps}, the injected L3 surface a dispatcher is
 *     constructed over;
 *   - {@link IssueCommandCtx}, the object handlers actually call.
 *
 * `registry.ts` imports {@link IssueCommandCtx} as a TYPE ONLY (the handler
 * signature), so the table contributes no runtime edge back to this module.
 */

import type { SessionId, SessionMeta } from '@podium/model'
import type { MutationLedgerPort } from '@podium/sync'
import { TRPCError } from '@trpc/server'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { authorize, type Capability, type IssueAccessIndex } from '../../issue-authz'
import type { MessageSender, MessageSendInput, MessageSendResult } from '../messages/service'
import type {
  IssueAttentionCapability,
  IssueCommentsMailCapability,
  IssueCrudCapability,
  IssueGitWorkflowCapability,
  IssueHierarchyCapability,
  IssueReportsCapability,
  IssueTrackerCapabilities,
} from './service'

/** Who is calling (authz identity) — the same pair the router Context carries. */
export interface IssueCaller {
  capability: Capability
  /** Authenticated transport principal; production dispatchers always provide it. */
  principal?: CommandPrincipal
  /** The agent passed --outside-scope: a knowing write outside its subtree. */
  overrideScope?: boolean
}

export interface IssueCommandDeps {
  /** Fully constructed tracker; command dispatch is activated after features. */
  issues: IssueTrackerCapabilities
  /**
   * Atomic issue/session attach workflow. The L3 application orchestrator owns
   * the shared transaction and carries this transport-derived caller unchanged
   * through both feature ports.
   */
  attachSession(
    caller: IssueCaller,
    input: Parameters<IssueAttentionCapability['attachSession']>[0],
  ): ReturnType<IssueAttentionCapability['attachSession']>
  /** Cross-aggregate issue tombstone + member-session deletion coordinator. */
  deleteIssue(id: string): unknown
  /** Cross-aggregate issue + member-session tombstone restoration coordinator. */
  restoreIssue(id: string): unknown
  /**
   * FRAMEWORK IDEMPOTENCY (POD-382): `@podium/sync`'s `MutationLedger`, injected.
   *
   * It used to be `withMutation`, a method borrowed from modules/sessions — an
   * issue command reaching into the session service for a property that belongs
   * to neither. The mechanism is unchanged (docs/spec/outbox-write-path.md §2.1);
   * what changed is that there is now ONE implementation and no per-proc wrapper
   * to omit.
   */
  mutations: MutationLedgerPort
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
    sessionId: SessionId,
    answer: string,
    caller: IssueCaller,
  ): Promise<{ ok: true; via: 'menu' | 'text' } | { ok: false; message: string }>
  /** Stop every session on an issue and free its worktree (keep branch)
   *  [spec:SP-9904]. Injected from SessionLifecycle; optional in bare tests. */
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

/** The narrow read surface the capability guard and `IssueCommandCtx.access`
 *  both decide against. Exported since POD-1398: `guardIssueCommand` lives with
 *  the table it reads defs from, and the dispatcher builds one per call. */
export type IssueCommandAccess = IssueAccessIndex &
  Pick<IssueReportsCapability, 'getMeta' | 'resolveRef'>

/** Flatten the two public capability contracts for the shared authz predicate. */
export function commandAccess(tracker: IssueTrackerCapabilities): IssueCommandAccess {
  return {
    has: (id) => tracker.reports.has(id),
    ownedTarget: (id, action) => tracker.reports.ownedTarget(id, action),
    ancestorIds: (id) => tracker.hierarchy.ancestorIds(id),
    getMeta: (id) => tracker.reports.getMeta(id),
    resolveRef: (ref, scopeRepoPath) => tracker.reports.resolveRef(ref, scopeRepoPath),
  }
}

/**
 * Per-call execution context handed to every command handler: the caller's
 * authz identity, narrowed tracker capabilities, and the cross-cutting helpers
 * forwarding, withMutation idempotency, mail identity, subscription scoping)
 * that used to be private methods of IssueCommandService.
 */
export class IssueCommandCtx {
  constructor(
    readonly deps: IssueCommandDeps,
    readonly caller: IssueCaller,
    private readonly name: string,
    _targetOf?: (input: Record<string, unknown>) => string | undefined,
  ) {}

  get crud(): IssueCrudCapability {
    return this.deps.issues.crud
  }
  get hierarchy(): IssueHierarchyCapability {
    return this.deps.issues.hierarchy
  }
  get commentsMail(): IssueCommentsMailCapability {
    return this.deps.issues.commentsMail
  }
  get attention(): IssueAttentionCapability {
    return this.deps.issues.attention
  }
  get gitWorkflow(): IssueGitWorkflowCapability {
    return this.deps.issues.gitWorkflow
  }
  get reports(): IssueReportsCapability {
    return this.deps.issues.reports
  }
  get access(): IssueCommandAccess {
    return commandAccess(this.deps.issues)
  }

  /**
   * The authenticated principal, or a refusal (POD-1315).
   *
   * `IssueCaller.principal` is optional because non-production dispatchers may
   * omit it, so every command that needs an identity must decide what an absent
   * one means. The only safe answer is UNAUTHORIZED: an unauthenticated caller
   * has no identity to act under, and the alternative — substituting one — is
   * how `addComment` came to act as the first admin for anyone who omitted it.
   */
  requirePrincipal(): CommandPrincipal {
    const principal = this.caller.principal
    if (!principal)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'missing authenticated command principal',
      })
    return principal
  }

  private readerUser(): string {
    const principal = this.caller.principal
    const user = principal ? onBehalfOfUser(principal) : null
    if (user === null) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'issue reads require a human principal' })
    }
    return user
  }

  mayReadIssue(id: string): boolean {
    const target = this.reports.ownedTarget(id, 'read')
    const user = this.readerUser()
    return target !== undefined && (target.owner === user || target.grants.includes(user))
  }

  requireReadableIssue(id: string): void {
    if (!this.mayReadIssue(id)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `unknown issue ${id}` })
    }
  }

  visibleRows<T extends { id: string }>(rows: readonly T[]): T[] {
    return rows.filter((row) => this.mayReadIssue(row.id))
  }

  readIssue<T>(id: string, read: () => T): T {
    this.requireReadableIssue(id)
    return read()
  }

  visibleGraph(
    graph: ReturnType<IssueReportsCapability['graph']>,
  ): ReturnType<IssueReportsCapability['graph']> {
    const nodes = this.visibleRows(graph.nodes)
    const ids = new Set(nodes.map((node) => node.id))
    return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) }
  }
  deleteIssue(id: string): unknown {
    return this.deps.deleteIssue(id)
  }
  restoreIssue(id: string): unknown {
    return this.deps.restoreIssue(id)
  }

  /** Framework idempotency, bound to this command's wire name (issues.<name>). */
  withMutation<T>(mutationId: string | undefined, fn: () => T): T {
    return this.deps.mutations.once(mutationId, `issues.${this.name}`, fn)
  }

  // RETIRED at POD-309: `issueWrite(input, local)` sat between every issue mutation
  // and its handler, routing a mutation whose target was a hub-mirrored issue to
  // `UpstreamForwarder` instead of the local tracker. With federation deferred there is no
  // second authority to forward to, so the wrapper's only remaining behaviour was
  // `return local()`. It was UNWRAPPED at its 28 call sites rather than left as a
  // pass-through: a wrapper with no content still reads as a policy seam, and the next
  // author to add a branch to it would be re-growing the forwarding path by accident.

  /** Agent-mail sender/claimer identity: the caller's bound issue (`issue:#<seq>`)
   *  for a subtree-scoped agent, else 'operator'. */
  mailIdentity(): string {
    if (this.caller.capability.scope.kind === 'subtree') {
      const me = this.reports.getMeta(this.caller.capability.scope.rootId)
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
  ownerAttribution(id: string): { actor: string; onBehalfOf: import('@podium/model').UserId } {
    const principal = this.caller.principal
    const row = this.reports.getMeta(id)
    if (principal?.kind !== 'user' || !row || row.ownerUserId !== principal.user) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'only the issue owner may change sharing' })
    }
    return { actor: principal.user, onBehalfOf: principal.user }
  }

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
      const id = this.reports.resolveRef(source.ref)
      const decision = authorize(
        this.caller.capability,
        'write',
        { id, ancestorIds: this.hierarchy.ancestorIds(id) },
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
        ancestorIds: this.hierarchy.ancestorIds(bound),
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
      const parent = this.reports.getMeta(parentId)
      if (!parent) return false
      if (parent.audience === 'human') return true
      parentId = parent.parentId
    }
    return false
  }
}
