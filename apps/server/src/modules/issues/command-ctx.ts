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

import type { IssueId, MutationId, SessionId, SessionMeta } from '@podium/model'
import { asSessionId, asUserId } from '@podium/model'
import type { MutationLedgerPort } from '@podium/sync'
import { TRPCError } from '@trpc/server'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { authorize, type Capability, type IssueAccessReader } from '../../issue-authz'
import type { MessageSender, MessageSendInput, MessageSendResult } from '../messages/service'
import type { ShippingService } from '../shipping'
import type { SyncWriteEntry } from '../sync-write/entry'
import type { IssueArtifactEffectPort } from './artifact-effect-record'
import type { IssueAuthorityArbitration } from './authority-arbitration'
import type { IssueGitEffectPort } from './git-effects'
import type {
  IssueAttentionCapability,
  IssueCommentsMailCapability,
  IssueCrudCapability,
  IssueGitWorkflowCapability,
  IssueHierarchyCapability,
  IssueReportsCapability,
  IssueTrackerCapabilities,
} from './service'
import type { IssueReader } from './service/reads'
import type { IssueWriter, WriterRest } from './service/types'
import type { IssueWorkEffectPort } from './work-effects'

/** Who is calling (authz identity) — the same pair the router Context carries. */
export interface IssueCaller {
  capability: Capability
  /**
   * The writer of the command this call is (ADR 12 D9, POD-6594): the sync write
   * entry point's `SyncWriteContext.ledger`. Absent for an issue command that
   * runs as an effect record's run (`forEffectRun`, the `issues.server`
   * origin); no served command runs a handler without one (POD-6603).
   */
  writer?: IssueWriter
  /** Authenticated transport principal; production dispatchers always provide it. */
  principal?: CommandPrincipal
  /** The agent passed --outside-scope: a knowing write outside its subtree. */
  overrideScope?: boolean
}

/** Who a session this caller starts is spawned by, as the session row records it. */
export function spawnProvenanceOf(capability: IssueCaller['capability']): string {
  if (capability.actorSessionId) return `session:${capability.actorSessionId}`
  if (capability.scope.kind === 'all') return 'user'
  if (capability.scope.kind === 'subtree') return `issue:${capability.scope.rootId}`
  return 'agent'
}

/** A send's delivery outcome, as a send answers it (`MessageSendResult`'s part). */
export type MailHandOn = Pick<
  MessageSendResult,
  'ok' | 'queued' | 'reason' | 'position' | 'disposition'
>

export interface IssueCommandDeps {
  /**
   * The writer of a handler run whose caller brings none. The served dispatcher
   * has none: every issue write is a sync command, which brings its own, or an
   * effect record, which never runs a handler in the request (POD-6603). Set
   * only by {@link IssueCommandDispatcher.forEffectRun} (an effect record's
   * run, after its commit) and by a dispatcher a test builds by hand.
   */
  directWriter?: IssueWriter
  /**
   * The writer of an effect record's run (`issues.server`): the issue
   * service's own work for a record that already committed, outside any
   * client command. {@link IssueCommandDispatcher.forEffectRun} uses it.
   */
  effectRunWriter?: IssueWriter
  /**
   * Merge, rebase, PR and integrate as effect records (POD-6394): the command
   * creates the record and answers once it settles. Absent only in a dispatcher
   * a test builds by hand, which then runs the git work inline as before.
   */
  gitEffects?: IssueGitEffectPort
  /**
   * The sync write entry point (ADR 12 D2), read per call: it is composed after
   * this dispatcher. When present, a relayed or MCP call of a command written
   * through it (`SYNCED_ISSUE_COMMANDS`) goes there (POD-6413). Absent only in a
   * dispatcher a test builds by hand.
   */
  syncWrite?: () => Pick<SyncWriteEntry, 'submitDetailed'>
  /**
   * Start, stop, sessions, cleanup, ship and the assistant as effect records
   * (POD-6414): the command creates the record and answers once it settles.
   * Absent in the executors' own dispatcher and in one a test builds by hand,
   * which run the work inline.
   */
  workEffects?: IssueWorkEffectPort
  /**
   * Adding, publishing and removing artifacts as effect records (POD-6420): the
   * old panelApply route creates the record and answers once it settles, and the
   * entry point's commit reads the record. Absent in a dispatcher a test builds
   * by hand, which moves the files inline.
   */
  artifactEffects?: IssueArtifactEffectPort
  /** Fully constructed tracker; command dispatch is activated after features. */
  issues: IssueTrackerCapabilities
  /** Cross-aggregate Shipping application port. Command handlers may nominate
   * or resolve once; atomic issue/order mutation stays inside the service. */
  shipping: Pick<ShippingService, 'enqueueCurrent' | 'resolveHold' | 'cancel' | 'deliveryReceipt'>
  /** Request-local bridge that binds exp-rev commands to their issue commit. */
  arbitration: Pick<IssueAuthorityArbitration, 'run'>
  /**
   * Atomic issue/session attach workflow. The L3 application orchestrator owns
   * the shared transaction and carries this transport-derived caller unchanged
   * through both feature ports.
   */
  attachSession(
    caller: IssueCaller,
    input: WriterRest<IssueAttentionCapability['attachSession']>[0],
  ): ReturnType<IssueAttentionCapability['attachSession']>
  /** Cross-aggregate issue tombstone + member-session deletion coordinator. */
  deleteIssue(writer: IssueWriter, id: string): unknown
  /** Cross-aggregate issue + member-session tombstone restoration coordinator. */
  restoreIssue(writer: IssueWriter, id: string): unknown
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
  /** ONE session by id, without the full reader-scoped pass [POD-1646].
   *  REQUIRED since POD-3857 — the full-list port it used to fall back to is
   *  gone, so the compiler keeps issue commands off the projection. */
  sessionById(sessionId: SessionId): Promise<SessionMeta | undefined>
  /** The member sessions of ONE issue, wired [POD-1639]. `issues.get` embeds
   *  them in its reply, so these do cross to a reader — but only an issue's
   *  own handful, never the fleet. */
  listSessionsForIssue(worktreePath: string | null, issueId: IssueId): Promise<SessionMeta[]>
  /** Registered repo paths, all machines (RepoRegistry.list() semantics). */
  repoPaths(): string[] | Promise<string[]>
  /** cwd → repo inference (RepoRegistry.inferFromPath semantics) — serves the
   *  relay-allowlisted `repos.inferFromPath` without touching the router. */
  inferRepoFromPath(path: string): string | undefined | Promise<string | undefined>
  /** Unified messaging send path (#237) [spec:SP-34d7] — the only way mail is
   *  sent. Optional so bare test dispatchers that never send keep working;
   *  mailSend refuses when it is absent. */
  sendMessage?(
    from: MessageSender,
    input: MessageSendInput,
  ): MessageSendResult | Promise<MessageSendResult>
  /** What a send's hand-on after its commit found (POD-6525,
   *  `MessageDeliveryService.handOnOf`): `mailSend`'s old doors answer with it. */
  mailHandOnOf?(messageId: string): Promise<MailHandOn | undefined>
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
    issueId: IssueId
    force?: boolean
    callerSessionId?: SessionId
    /** Who asked for the stop — stamped onto the free-worktree audit comment (POD-1344). */
    principal: CommandPrincipal
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
export type IssueCommandAccess = IssueAccessReader &
  Pick<IssueReportsCapability, 'getMeta' | 'resolveRef'>

/** Flatten the two public capability contracts for the shared authz predicate. */
export function commandAccess(tracker: IssueTrackerCapabilities): IssueCommandAccess {
  return {
    has: async (id) => await tracker.reports.has(id),
    ownedTarget: async (id, action) => await tracker.reports.ownedTarget(id, action),
    ancestorIds: async (id) => await tracker.hierarchy.ancestorIds(id),
    getMeta: async (id) => await tracker.reports.getMeta(id),
    resolveRef: async (ref, scopeRepoPath) => await tracker.reports.resolveRef(ref, scopeRepoPath),
  }
}

/** A function whose first parameter is the writer, without it. */
type DropWriter<F> = F extends (writer: IssueWriter, ...rest: infer A) => infer R
  ? (...rest: A) => R
  : never

/**
 * A capability with its write methods `K` bound to one writer (ADR 12 D9). The
 * keys are listed per capability below; a write method left off its list keeps
 * its writer parameter, so a handler that calls it without one does not compile.
 */
export type Bound<T, K extends keyof T> = Omit<T, K> & { readonly [P in K]: DropWriter<T[P]> }

/**
 * The writer is resolved when a WRITE method is called, never when the view is
 * taken: a read (a query handler, the reads before a write) reaches the same
 * capability view and has no writer to give (POD-6603).
 */
function bindWriter<T extends object, K extends keyof T>(
  target: T,
  writer: () => IssueWriter,
  keys: readonly K[],
): Bound<T, K> {
  const view = Object.create(target) as Record<PropertyKey, unknown>
  for (const key of keys) {
    const method = target[key] as unknown as (...args: unknown[]) => unknown
    view[key as PropertyKey] = (...args: unknown[]) => method.call(target, writer(), ...args)
  }
  return view as unknown as Bound<T, K>
}

const CRUD_WRITES = [
  'setState',
  'panelApply',
  'panelArtifactAdd',
  'panelArtifactUpload',
  'panelArtifactTransfer',
  'panelArtifactRemove',
  'panelChatUploadClaim',
  'create',
  'update',
  'move',
  'markIssueRead',
  'markIssueUnread',
  'setIssueTucked',
  'setLabels',
  'share',
  'unshare',
  'claim',
  'setCoordinator',
  'close',
  'applySuggestion',
  'dismissSuggestion',
] as const satisfies readonly (keyof IssueCrudCapability)[]
const HIERARCHY_WRITES = [
  'addDep',
  'removeDep',
  'reparent',
  'supersede',
  'duplicate',
] as const satisfies readonly (keyof IssueHierarchyCapability)[]
const MAIL_WRITES = [
  'addComment',
  'addCallerComment',
] as const satisfies readonly (keyof IssueCommentsMailCapability)[]
const ATTENTION_WRITES = [
  'attachSession',
  'createDraftFor',
  'archive',
  'defer',
  'undefer',
  'setNeedsHuman',
  'clearNeedsHuman',
  'markIssueRead',
  'markIssueUnread',
  'setIssueTucked',
] as const satisfies readonly (keyof IssueAttentionCapability)[]
const WORKFLOW_WRITES = [
  'rehome',
  'createAndMaybeStart',
] as const satisfies readonly (keyof IssueGitWorkflowCapability)[]

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

  /**
   * The writer this command's writes commit on: its own, or an effect record
   * run's (see {@link IssueCommandDeps.directWriter}).
   */
  get writer(): IssueWriter {
    const own = this.caller.writer
    if (own !== undefined) return own
    const direct = this.deps.directWriter
    if (direct === undefined) {
      throw new Error(`issues.${this.name} has no writer: it runs outside sync.submit`)
    }
    return direct
  }

  /** The capabilities, with their write methods bound to {@link writer}: a
   *  handler calls `ctx.crud.update(id, patch)` and the write is the command's. */
  get crud(): Bound<IssueCrudCapability, (typeof CRUD_WRITES)[number]> {
    return bindWriter(this.deps.issues.crud, () => this.writer, CRUD_WRITES)
  }
  get hierarchy(): Bound<IssueHierarchyCapability, (typeof HIERARCHY_WRITES)[number]> {
    return bindWriter(this.deps.issues.hierarchy, () => this.writer, HIERARCHY_WRITES)
  }
  get commentsMail(): Bound<IssueCommentsMailCapability, (typeof MAIL_WRITES)[number]> {
    return bindWriter(this.deps.issues.commentsMail, () => this.writer, MAIL_WRITES)
  }
  get attention(): Bound<IssueAttentionCapability, (typeof ATTENTION_WRITES)[number]> {
    return bindWriter(this.deps.issues.attention, () => this.writer, ATTENTION_WRITES)
  }
  get gitWorkflow(): Bound<IssueGitWorkflowCapability, (typeof WORKFLOW_WRITES)[number]> {
    return bindWriter(this.deps.issues.gitWorkflow, () => this.writer, WORKFLOW_WRITES)
  }
  get reports(): IssueReportsCapability {
    return this.deps.issues.reports
  }
  get shipping(): IssueCommandDeps['shipping'] {
    return this.deps.shipping
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

  async mayReadIssue(id: string): Promise<boolean> {
    const target = await this.reports.ownedTarget(id, 'read')
    const user = this.readerUser()
    return target !== undefined && (target.owner === user || target.grants.includes(user))
  }

  /**
   * The caller as a report reader (POD-6191): a listing filters by its user in
   * SQL with the rule {@link mayReadIssue} applies per row, and asks
   * `mayRead` for the single issues it shows beside them.
   */
  issueReader(): IssueReader {
    return {
      readableBy: () => asUserId(this.readerUser()),
      mayRead: async (id) => await this.mayReadIssue(id),
    }
  }

  async requireReadableIssue(id: string): Promise<void> {
    if (!(await this.mayReadIssue(id))) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `unknown issue ${id}` })
    }
  }

  async visibleRows<T extends { id: string }>(rows: readonly T[]): Promise<T[]> {
    const visible = await Promise.all(rows.map((row) => this.mayReadIssue(row.id)))
    return rows.filter((_, index) => visible[index])
  }

  async readIssue<T>(id: string, read: () => T | Promise<T>): Promise<T> {
    await this.requireReadableIssue(id)
    return await read()
  }

  async visibleGraph(
    graph: Awaited<ReturnType<IssueReportsCapability['graph']>>,
  ): Promise<Awaited<ReturnType<IssueReportsCapability['graph']>>> {
    const nodes = await this.visibleRows(graph.nodes)
    const ids = new Set(nodes.map((node) => node.id))
    return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) }
  }
  deleteIssue(id: string): unknown {
    return this.deps.deleteIssue(this.writer, id)
  }
  restoreIssue(id: string): unknown {
    return this.deps.restoreIssue(this.writer, id)
  }

  /** Framework idempotency, bound to this command's wire name (issues.<name>). */
  async withMutation<T>(
    mutationId: MutationId | undefined,
    fn: () => T | Promise<T>,
  ): Promise<Awaited<T>> {
    return await this.deps.mutations.once(mutationId, `issues.${this.name}`, fn)
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
  async mailIdentity(): Promise<string> {
    if (this.caller.capability.scope.kind === 'subtree') {
      const me = await this.reports.getMeta(this.caller.capability.scope.rootId)
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
  async ownerAttribution(
    id: string,
  ): Promise<{ actor: string; onBehalfOf: import('@podium/model').UserId }> {
    const principal = this.caller.principal
    const row = await this.reports.getMeta(id)
    if (principal?.kind !== 'user' || !row || row.ownerUserId !== principal.user) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'only the issue owner may change sharing' })
    }
    return { actor: principal.user, onBehalfOf: principal.user }
  }

  spawnProvenance(): string {
    return spawnProvenanceOf(this.caller.capability)
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

  /** Resolve `issues.ship`'s optional target only from authenticated server
   * scope. Operators and unattached agents have no implicit issue. */
  async shipIssue(id?: string): Promise<IssueId> {
    if (id) {
      const scopeRepoPath =
        this.caller.capability.scope.kind === 'subtree'
          ? ((await this.reports.getMeta(this.caller.capability.scope.rootId))?.repoPath ??
            undefined)
          : undefined
      return await this.reports.resolveRef(id, scopeRepoPath)
    }
    if (this.caller.capability.scope.kind === 'subtree') {
      return this.caller.capability.scope.rootId
    }
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
  async assertSourceInSubtree(source: {
    kind: 'relationship' | 'issue' | 'session'
    ref: string
  }): Promise<void> {
    if (source.kind === 'issue') {
      const id = await this.reports.resolveRef(source.ref)
      const decision = authorize(
        this.caller.capability,
        'write',
        { id, ancestorIds: await this.hierarchy.ancestorIds(id) },
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
    const bound = (await this.deps.sessionById(asSessionId(source.ref)))?.issueId
    const ok =
      bound != null &&
      authorize(this.caller.capability, 'write', {
        id: bound,
        ancestorIds: await this.hierarchy.ancestorIds(bound),
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
  async hasHumanAudienceAncestor(issue: { parentId?: string | null }): Promise<boolean> {
    const seen = new Set<string>()
    let parentId: string | null | undefined = issue.parentId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = await this.reports.getMeta(parentId)
      if (!parent) return false
      if (parent.audience === 'human') return true
      parentId = parent.parentId
    }
    return false
  }
}
