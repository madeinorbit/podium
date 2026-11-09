import { readIssue, readIssues } from './modules/issues/issue-reader'
/**
 * THE FEED'S VISIBILITY POLICY (POD-418).
 *
 * Moved out of the composition root verbatim — LOGIC UNCHANGED. This is the
 * implementation of two ports the sync kernel already declares,
 * {@link VisibilityStatePort} and {@link VisibilityAnchorPort}, plus the
 * per-bootstrap read tracing the perf registry wants from around them. The root
 * used to hold all three inline, which made ~300 lines of *policy* — who may
 * read which row, and how few queries it takes to answer — live inside a
 * constructor whose entire claim is that it decides nothing and only wires.
 *
 * It is one job with one piece of protected state: `traces` is the stack a
 * bootstrap pushes so every store read it causes is attributed to a phase. It
 * does not escape this module, and nothing here reaches back into a service —
 * the whole surface is store reads. Since POD-6156 nothing here holds rows
 * either: the anchor port reads the rows a batch names from the database.
 *
 * WHY IT ALSO REPAIRED THE CONSTRUCTION-ORDER GATE. `forBootstrap` declares a
 * local `const issues` for the prefetched issue rows. Inside the root that name
 * collided with the `issues` SERVICE declared ~250 lines later, and
 * `scripts/server-construction-order.ts` matches identifiers without scope
 * analysis — so it read the local as a forward dependency on the service and
 * threw, which is why the committed record had gone stale and could not be
 * regenerated. Out here there is no service named `issues` to collide with, and
 * the shadowing is gone rather than worked around.
 */

import {
  asIssueId,
  asUserId,
  canonicalShippingDestination,
  type IssueExecutionFacts,
  type IssueId,
  issueDepFromPrefix,
  issueExecutionAccess,
  issueExecutionSessionIds,
  parseInteractionRowId,
  parseIssueDepId,
  parseIssueEventRowId,
  parseIssueUserStateRowId,
  parseLayoutRowId,
  parseMessageRecordRowId,
  parsePinRowId,
  parseReadPositionRowId,
  parseSessionUserStateRowId,
  parseSuperagentThreadRowId,
  parseSubscriptionRowId,
  parseTabOrderRowId,
  parseUserPreferencesRowId,
  parseWorkflowBindingRowId,
  type RepoId,
  shipLaneId,
  type UserId,
  withoutHiddenEventFields,
  withoutHiddenExecutionFields,
} from '@podium/model'
import type { Principal } from '@podium/protocol'
import type {
  EntityRef,
  VisibilityAnchorPort,
  VisibilityEdge,
  VisibilityStatePort,
} from '@podium/sync'
import type { FeedVisibilityStore, GrantRow, IssueRow, SessionRow } from './hot-path-ports'
import { custodianFromEdges, executionPointersOf } from './modules/issues/execution-visibility'
import { INSTANCE_EFFECT_KINDS } from './modules/operations/instance-effect-kinds'
import { perfPrincipal } from './modules/perf/principal'
import { perf } from './modules/perf/registry'
import type { EffectAudience } from './store/effects'
import type { WorkflowVisibilityFacts } from './store/workflows'

/**
 * The store reads a feed bootstrap can cause, named so each is separately
 * attributable. These are the strings `feedBootstrap.<phase>` is built from —
 * renaming one renames a perf series.
 */
type BootstrapReadPhase =
  | 'visibility.issue.getIssue'
  | 'visibility.session.getSession'
  | 'visibility.conversation.findSessionByResumeValue'
  | 'visibility.automation.ownerOf'
  | 'visibility.automationRun.runOwnerOf'
  | 'visibility.effect.audiencesOf'
  | 'visibility.effect.adminIds'
  | 'visibility.effect.liveOnTargets'
  | 'visibility.shipOrder.issueIdForOrder'
  | 'visibility.shipLane.memberIssueIds'
  | 'visibility.grants.listForResources'
  | 'visibility.workflow.facts'
  | 'visibility.workflow.adminIds'
  | 'visibility.workflow.grants'

interface BootstrapReadTrace {
  readonly phases: Map<BootstrapReadPhase, number>
}

/**
 * Rows the bootstrap pass already fetched in bulk. Present only on the state
 * built for one serving pass; the root port has none and fails closed.
 */
type BootstrapVisibilityPrefetch = {
  readonly issueIds: ReadonlySet<string>
  readonly issues: ReadonlyMap<string, IssueRow>
  readonly shipOrderIds: ReadonlySet<string>
  readonly issueIdsByShipOrder: ReadonlyMap<string, string>
  /** POD-4974 O2: each prefetched lane's member issues, read from the lane's
   * queued orders after the commit. */
  readonly shipLaneIds: ReadonlySet<string>
  readonly issueIdsByShipLane: ReadonlyMap<string, readonly string[]>
  readonly sessionIds: ReadonlySet<string>
  readonly sessions: ReadonlyMap<string, SessionRow>
  readonly resumeValues: ReadonlySet<string>
  readonly sessionsByResumeValue: ReadonlyMap<string, SessionRow>
  /** Grant edges for this pass, one grouped read per resource kind.
   * ID sets distinguish an empty answer from an unprepared ref.
   */
  /** The custodian of every machine a prepared task is homed on (POD-6288);
   *  absent = nobody holds custody. Issue grants are no longer read: they
   *  decide nothing about a task. */
  readonly machineCustodians: ReadonlyMap<string, UserId>
  readonly automationIds: ReadonlySet<string>
  readonly automationOwners: ReadonlyMap<string, UserId | undefined>
  readonly automationRunIds: ReadonlySet<string>
  readonly automationRunOwners: ReadonlyMap<string, UserId | undefined>
  /** Each asked effect's creator and target, through the tombstone (POD-6357). */
  readonly effectAudiences: ReadonlyMap<string, EffectAudience>
  /** The admins who can act, read only when an instance-wide effect is asked (POD-6358). */
  readonly adminIds: ReadonlySet<string>
  /** The owners the workflow kinds are decided by (POD-6676), every asked id
   *  present when it has a row. */
  readonly workflowFacts: WorkflowVisibilityFacts
  /** `user\0kind\0id` for every READ grant on an asked workflow-family row. */
  readonly workflowReadGrants: ReadonlySet<string>
  /** The active admins, read only when a workflow-family row is asked: an admin
   *  reads every one, as `workflowDecision`'s last arm. */
  readonly workflowAdminIds: ReadonlySet<string>
}

/** The ownership entity a workflow is decided as: a global one is a library
 *  entry (`WorkflowAccess.entityFor`). */
const workflowEntityKind = (scope: string): 'workflow-library-entry' | 'workflow-definition' =>
  scope === 'global' ? 'workflow-library-entry' : 'workflow-definition'

/** A pass with no workflow-family row reads none of their facts. */
const NO_WORKFLOW_FACTS: WorkflowVisibilityFacts = {
  workflows: new Map(),
  revisions: new Map(),
  bindings: new Map(),
  runs: new Map(),
}

type IssueDepSubject = {
  entity: 'issueDep'
  entityId: string
}

type ShipOrderSubject = {
  entity: 'shipOrder'
  entityId: string
}

type ShipLaneSubject = {
  entity: 'shipLane'
  entityId: string
}

type EffectSubject = {
  entity: 'effect'
  entityId: string
}

/** The store surface this policy reads. Nothing here writes. */
export interface FeedVisibilityDeps {
  readonly store: FeedVisibilityStore
  /** The historical audience of each resource, every asked id present, `[]` for
   * none. It includes revoked readers, which current grant edges cannot replace;
   * the grant writer owns it. */
  readonly audiencesFor: (
    kind: string,
    ids: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly string[]>>
  readonly authorizationRevision: () => Promise<number>
  /**
   * The `issueEvent` rows the feed currently carries for one issue (POD-1772).
   *
   * An issue's audience changes by a grant, and every row that rides that
   * audience has to be re-scoped with it — otherwise a new reader gets the issue
   * and none of its history. The publisher answers this from its in-memory
   * window, so the anchor costs no query; it is a FUNCTION because the publisher
   * needs the ledger this policy is constructed before.
   *
   * Omitted in tests that predate the kind: no rows, no subjects.
   */
  readonly issueEventSubjects?: (issueId: IssueId) => { entity: 'issueEvent'; entityId: string }[]
}

/** What the composition root names: two ports plus the tracing bracket. */
export interface FeedVisibility {
  /** The kernel's state port — what `GrantEdgeVisibilityPolicy` is built over. */
  readonly state: VisibilityStatePort
  /** The kernel's anchor port — what the `Ledger` scopes issue fan-out with. */
  readonly anchors: VisibilityAnchorPort
  /** Open a read-attribution frame for one bootstrap. */
  readonly beginBootstrapRead: () => void
  /** Close it and record every phase it accumulated against `principal`. */
  readonly finishBootstrapRead: (principal: Principal) => void
  /** Authority signal for mutations that can change a scoped answer without
   * moving the change-log head (notably a same-value issue upsert beside a grant
   * revoke). Long-lived world caches validate this as well as the head. */
  readonly authorizationRevision: () => Promise<number>
  /**
   * "May this user read this issue?", exported because the mail policy's
   * resolution-time ceiling asks the same question the feed does and a second
   * copy of that answer is how the two quietly stop agreeing.
   */
  readonly mayReadIssue: (userId: UserId, issueId: IssueId) => Promise<boolean>
}

export function makeFeedVisibility(deps: FeedVisibilityDeps): FeedVisibility {
  const { store } = deps

  const traces: BootstrapReadTrace[] = []
  const measure = async <T>(phase: BootstrapReadPhase, fn: () => T | Promise<T>): Promise<T> => {
    const trace = traces[traces.length - 1]
    if (trace === undefined) return await fn()
    const startedAt = performance.now()
    try {
      return await fn()
    } finally {
      trace.phases.set(phase, (trace.phases.get(phase) ?? 0) + (performance.now() - startedAt))
    }
  }
  const beginBootstrapRead = (): void => {
    traces.push({ phases: new Map() })
  }
  const finishBootstrapRead = (principal: Principal): void => {
    const trace = traces.pop()
    if (trace === undefined) return
    const perfKey = perfPrincipal(principal)
    for (const [phase, durationMs] of trace.phases) {
      perf.record('phase', `feedBootstrap.${phase}`, durationMs, perfKey)
    }
  }

  /**
   * MAY THIS PERSON READ THIS TASK: yes, for every task that exists (design
   * §2.2, D4; POD-6288). Tasks are shared; issue grants are inert history and
   * decide nothing. The person is an authenticated member: the feed serves no
   * other human. The command layer decides the same question the same way
   * (`IssueCommandCtx.mayReadIssue`, `checkIssueAccess`), so the two never
   * disagree. What a reader may NOT receive of a task, its execution-private
   * fields, is `shapeFor`'s business, not this one's.
   */
  const mayReadIssue = async (_userId: UserId, issueId: IssueId): Promise<boolean> => {
    // The repository commit installs the owned row map before publication.
    // Open mutation spans still read their own writes through the live fallback.
    const row = await measure(
      'visibility.issue.getIssue',
      async () => await readIssue(store.issues, issueId),
    )
    return row !== null
  }

  const mayReadIssueFromSnapshot = (
    _userId: string,
    issueId: string,
    snapshot: BootstrapVisibilityPrefetch,
  ): boolean => snapshot.issueIds.has(issueId) && snapshot.issues.has(issueId)

  /**
   * MAY THIS PERSON READ THIS WORKFLOW-FAMILY ROW (POD-6676): today's read rule,
   * `workflowDecision`'s, from one pass's facts. Its owner, a person holding an
   * explicit read grant on it, or an admin; a row with no owner is the admins'
   * alone (fail closed, ADR 9 D4). A revision is read as its workflow is.
   * Workflow rows are never deleted (a workflow archives), so an absent row is
   * denied.
   */
  const mayReadWorkflowRow = (
    userId: string,
    entity: 'workflow' | 'workflowRevision' | 'workflowBinding' | 'workflowRun',
    id: string,
    snapshot: BootstrapVisibilityPrefetch,
  ): boolean => {
    const facts = snapshot.workflowFacts
    let owner: string | null | undefined
    let grant: string
    if (entity === 'workflow' || entity === 'workflowRevision') {
      const found = entity === 'workflow' ? facts.workflows.get(id) : facts.revisions.get(id)
      if (found === undefined) return false
      owner = found.ownerUserId
      const workflowId = 'workflowId' in found ? found.workflowId : id
      grant = `${workflowEntityKind(found.scope)}\u0000${workflowId}`
    } else if (entity === 'workflowBinding') {
      if (!facts.bindings.has(id)) return false
      owner = facts.bindings.get(id)
      grant = `workflow-binding\u0000${id}`
    } else {
      if (!facts.runs.has(id)) return false
      owner = facts.runs.get(id)
      grant = `workflow-run\u0000${id}`
    }
    if (owner != null && owner === userId) return true
    if (snapshot.workflowReadGrants.has(`${userId}\u0000${grant}`)) return true
    return snapshot.workflowAdminIds.has(userId)
  }

  /** The facts the execution-private rule reads for one prepared pass. */
  const executionFactsOf = (snapshot: BootstrapVisibilityPrefetch): IssueExecutionFacts => ({
    custodianOf: (machineId) => snapshot.machineCustodians.get(machineId) ?? null,
    sessionOwnerOf: (sessionId) => {
      const row = snapshot.sessions.get(sessionId)
      return row === undefined ? undefined : (row.ownerUserId ?? null)
    },
  })

  const makeVisibilityState = (prefetch?: BootstrapVisibilityPrefetch): VisibilityStatePort => {
    /** MAY THIS PERSON SEE THIS SESSION — its owner only (design §2.3,
     *  POD-6283). A legacy session grant is kept and has no effect.
     *
     *  Extracted (POD-2020) because `pendingInteraction` answers the same question
     *  about the session named in its row id, and two copies of a visibility rule
     *  is one copy that eventually says yes when the other says no. */
    const maySeeSession = (userId: string, sessionId: string): boolean => {
      if (!prefetch?.sessionIds.has(sessionId)) return false
      return prefetch.sessions.get(sessionId)?.ownerUserId === userId
    }
    return {
      classOf: (entity) => {
        if (entity === 'repo' || entity === 'machine') return 'deployment-substrate'
        // Agent profiles are instance substrate (POD-6676, matrix row
        // `agent-profiles`): every member reads every profile.
        if (entity === 'agentProfile') return 'deployment-substrate'
        // Per-user shell layout (POD-1350): never grantable; keyedUserOf owns the
        // filter. Must NOT fall through to personal or unclassified.
        if (entity === 'userLayout') return 'per-user-state'
        // Per-user read positions (POD-1380): same class, same reason. A cursor
        // that fell through to `personal` would be grantable, and "share my read
        // state" is not a verb — it is the privacy defect this member exists to
        // avoid.
        if (entity === 'userReadPosition') return 'per-user-state'
        if (entity === 'issueUserState' || entity === 'sessionUserState') return 'per-user-state'
        // Pins, tab orders and personal preferences (POD-6673): the owner's alone.
        if (entity === 'pin' || entity === 'tabOrder' || entity === 'userPreferences') {
          return 'per-user-state'
        }
        // A superagent thread (POD-6675): its owner's alone, as ADR 9 D8 S2 says.
        if (entity === 'superagentThread') return 'per-user-state'
        if (
          entity === 'session' ||
          entity === 'issueProjection' ||
          entity === 'issueGitState' ||
          entity === 'issueDep' ||
          // A curated issue event (POD-1772). `personal` and NOT a class of its
          // own: it is readable by exactly the audience of the issue it is about,
          // which is what `personal` + `mayRead` already spells.
          entity === 'issueEvent' ||
          // A blocking ask (POD-2020). `personal` and not a class of its own, the
          // same argument as `issueEvent` one line up: an ask is readable by
          // exactly the audience of the SESSION it blocks, which is what
          // `personal` + `mayRead` already spells.
          entity === 'pendingInteraction' ||
          // A person's chat message (POD-4764). `personal`: readable by the
          // person who sent it and the owner of the session it went to, both
          // named in its row id — see the `message` arm of `mayRead`.
          entity === 'message' ||
          entity === 'shipOrder' ||
          // A delivery lane (POD-4974 O2). `personal`: readable by whoever may
          // read at least one order in it (decision 2), the `mayRead` arm below.
          entity === 'shipLane' ||
          entity === 'conversation' ||
          entity === 'automation' ||
          entity === 'automationRun' ||
          // A one-shot effect (POD-6357). `personal`: readable by its creator and
          // by whoever may read its target, the `mayRead` arm below.
          entity === 'effect' ||
          // Workflows and trigger subscriptions (POD-6676): `personal`, decided by
          // their owner (workflows) or their subscriber (subscriptions), below.
          entity === 'workflow' ||
          entity === 'workflowRevision' ||
          entity === 'workflowBinding' ||
          entity === 'workflowRun' ||
          entity === 'subscription'
        )
          return 'personal'
        return null
      },
      mayRead: (userId, ref) => {
        // An unresolved root policy, or a ref outside this pass, denies. The
        // producer must prepare every ref before entering the synchronous loop.
        if (!prefetch) return false
        if (ref.entity === 'issueProjection' || ref.entity === 'issueGitState') {
          return mayReadIssueFromSnapshot(userId, ref.entityId, prefetch)
        }
        if (ref.entity === 'issueDep') {
          const dep = parseIssueDepId(ref.entityId)
          return dep !== null && mayReadIssueFromSnapshot(userId, dep.fromId, prefetch)
        }
        if (ref.entity === 'issueEvent') {
          try {
            return mayReadIssueFromSnapshot(
              userId,
              parseIssueEventRowId(ref.entityId).subject,
              prefetch,
            )
          } catch {
            return false
          }
        }
        if (ref.entity === 'shipOrder') {
          if (!prefetch.shipOrderIds.has(ref.entityId)) return false
          const issueId = prefetch.issueIdsByShipOrder.get(ref.entityId)
          return issueId !== undefined && mayReadIssueFromSnapshot(userId, issueId, prefetch)
        }
        if (ref.entity === 'shipLane') {
          if (!prefetch.shipLaneIds.has(ref.entityId)) return false
          return (prefetch.issueIdsByShipLane.get(ref.entityId) ?? []).some((issueId) =>
            mayReadIssueFromSnapshot(userId, issueId, prefetch),
          )
        }
        if (ref.entity === 'pendingInteraction') {
          try {
            return maySeeSession(userId, parseInteractionRowId(ref.entityId).sessionId)
          } catch {
            return false
          }
        }
        if (ref.entity === 'message') {
          // Its sender, and the owner of the session it was sent to — not every
          // reader of that session: a message on its way is the sender's and the
          // owner's business until it lands in the transcript.
          try {
            const { sessionId, senderUserId } = parseMessageRecordRowId(ref.entityId)
            if (senderUserId === userId) return true
            return (
              prefetch.sessionIds.has(sessionId) &&
              prefetch.sessions.get(sessionId)?.ownerUserId === userId
            )
          } catch {
            return false
          }
        }
        if (ref.entity === 'session') return maySeeSession(userId, ref.entityId)
        if (ref.entity === 'conversation') {
          if (!prefetch.resumeValues.has(ref.entityId)) return false
          const row = prefetch.sessionsByResumeValue.get(ref.entityId)
          // A conversation is its session's: the owner only (POD-6283).
          return row?.ownerUserId === userId
        }
        if (ref.entity === 'automation') {
          return (
            prefetch.automationIds.has(ref.entityId) &&
            prefetch.automationOwners.get(ref.entityId) === userId
          )
        }
        if (ref.entity === 'automationRun') {
          return (
            prefetch.automationRunIds.has(ref.entityId) &&
            prefetch.automationRunOwners.get(ref.entityId) === userId
          )
        }
        if (ref.entity === 'effect') {
          // Its creator, and the readers of what it acts on. A machine target
          // admits the creator alone until the machine kinds define more.
          const audience = prefetch.effectAudiences.get(ref.entityId)
          if (audience === undefined) return false
          // An instance-wide effect (a software update, a server move) is every
          // admin's and no member's, even a member who started it as an admin.
          if (INSTANCE_EFFECT_KINDS.has(audience.kind)) return prefetch.adminIds.has(userId)
          if (audience.createdBy === userId) return true
          // A gated record's people (POD-6674): an approval its owner may not
          // run is routed to the admins who may, who may not read its target.
          if (audience.deciders?.includes(userId as never) === true) return true
          if (audience.targetKind === 'issue') {
            return mayReadIssueFromSnapshot(userId, audience.targetId, prefetch)
          }
          if (audience.targetKind === 'session') return maySeeSession(userId, audience.targetId)
          return false
        }
        if (ref.entity === 'subscription') {
          // Its SUBSCRIBER's audience (design §1.11): a session's owner, or
          // whoever may read the task (every member). Read from the id, so a
          // removal is scoped like the row it removes.
          try {
            const { subscriberKind, subscriberId } = parseSubscriptionRowId(ref.entityId)
            return subscriberKind === 'session'
              ? maySeeSession(userId, subscriberId)
              : mayReadIssueFromSnapshot(userId, subscriberId, prefetch)
          } catch {
            return false
          }
        }
        if (
          ref.entity === 'workflow' ||
          ref.entity === 'workflowRevision' ||
          ref.entity === 'workflowBinding' ||
          ref.entity === 'workflowRun'
        ) {
          return mayReadWorkflowRow(userId, ref.entity, ref.entityId, prefetch)
        }
        // per-user-state is decided by keyedUserOf, not mayRead.
        return false
      },
      keyedUserOf: (ref) => {
        if (ref.entity === 'sessionUserState') {
          try {
            return parseSessionUserStateRowId(ref.entityId).userId
          } catch {
            return null
          }
        }
        if (ref.entity === 'issueUserState') {
          try {
            return parseIssueUserStateRowId(ref.entityId).userId
          } catch {
            return null
          }
        }
        if (ref.entity === 'userReadPosition') {
          try {
            return parseReadPositionRowId(ref.entityId).userId
          } catch {
            return null
          }
        }
        if (ref.entity === 'pin' || ref.entity === 'tabOrder' || ref.entity === 'userPreferences') {
          try {
            if (ref.entity === 'pin') return parsePinRowId(ref.entityId).userId
            if (ref.entity === 'tabOrder') return parseTabOrderRowId(ref.entityId).userId
            return parseUserPreferencesRowId(ref.entityId).userId
          } catch {
            return null
          }
        }
        if (ref.entity === 'superagentThread') {
          try {
            return parseSuperagentThreadRowId(ref.entityId).userId
          } catch {
            return null
          }
        }
        if (ref.entity !== 'userLayout') return null
        try {
          return parseLayoutRowId(ref.entityId).userId
        } catch {
          return null
        }
      },
      /**
       * A TASK AS THIS PERSON MAY RECEIVE IT (design §4.2, POD-6288): its
       * worktree and machine only for the machine's custodian, its session
       * pointers only for those sessions' owners. Everything else on the row
       * is shared. Decided from this pass's prefetch, like `mayRead`.
       */
      shapeFor: (userId, ref, value) => {
        if (!prefetch || value === null || typeof value !== 'object') return value
        if (ref.entity === 'issueEvent') {
          // A task event's payload by the same rule as the task's fields
          // (POD-6291): `issue.started` names the worktree, `session_attached`
          // a session. A session the pass did not read points at no person,
          // so its id goes to the task's assignee alone.
          let subject: string
          try {
            subject = parseIssueEventRowId(ref.entityId).subject
          } catch {
            return value
          }
          const row = prefetch.issues.get(subject)
          if (!row) return value
          const event = value as { kind?: unknown; payload?: unknown }
          const kind = typeof event.kind === 'string' ? event.kind : ''
          const payload = withoutHiddenEventFields(
            kind,
            event.payload,
            issueExecutionAccess(userId, executionPointersOf(row), executionFactsOf(prefetch)),
          )
          return payload === event.payload ? value : { ...event, payload }
        }
        if (ref.entity !== 'issueProjection') return value
        const row = prefetch.issues.get(ref.entityId)
        if (!row) return value
        return withoutHiddenExecutionFields(
          value,
          issueExecutionAccess(userId, executionPointersOf(row), executionFactsOf(prefetch)),
        )
      },
      forBootstrap: (refs: readonly EntityRef[]) => prepareOver(refs),
      /**
       * THE SAME PREPARATION FOR ONE APPENDED BATCH [POD-3261].
       *
       * Literally the same function, and deliberately not a differently-tuned
       * one. The two passes differ in SIZE — a world versus a handful of rows —
       * and in nothing else that this port can see: the same kinds arrive, the
       * same reads answer them, and a second implementation would be a second
       * place for the two to stop agreeing about who may read what.
       *
       * The batch pass is what makes phase 3 scoping affordable on a remote
       * database: `Authority.broadcast` prepares once per batch and reuses it
       * across every subscribed principal, so a batch costs a fixed few queries
       * instead of one per row per principal.
       */
      forBatch: (refs: readonly EntityRef[]) => prepareOver(refs),
    }
  }

  /**
   * Read every row one pass of `decide` will reach, in as few queries as the
   * store has batched readers for.
   *
   * ORDER IS LOAD-BEARING. Ship orders resolve to issue ids and conversations
   * resolve to session ids, so both must land before the grant read: a grant
   * list fetched for the ids known at the top of this function would miss
   * exactly the resources the indirection introduced. The synchronous decision
   * pass cannot recover with a live read, so an omitted resource would be denied
   * even when it should be visible.
   */
  const prepareOver = async (refs: readonly EntityRef[]): Promise<VisibilityStatePort> => {
    const issueIds = new Set<string>()
    const shipOrderIds = new Set<string>()
    const shipLaneIds = new Set<string>()
    const sessionIds = new Set<string>()
    const resumeValues = new Set<string>()
    const automationIds = new Set<string>()
    const automationRunIds = new Set<string>()
    const effectIds = new Set<string>()
    const workflowIds = new Set<string>()
    const workflowRevisionIds = new Set<string>()
    const workflowBindingIds = new Set<string>()
    const workflowRunIds = new Set<string>()
    for (const ref of refs) {
      if (ref.entity === 'issueProjection' || ref.entity === 'issueGitState') {
        issueIds.add(ref.entityId)
      } else if (ref.entity === 'issueDep') {
        const dep = parseIssueDepId(ref.entityId)
        if (dep !== null) issueIds.add(dep.fromId)
      } else if (ref.entity === 'issueEvent') {
        // Same prefetch as its subject issue: a bootstrap carrying a window of
        // events must not become one `getIssue` per event (POD-1614's lesson,
        // applied before the kind can repeat it).
        try {
          issueIds.add(parseIssueEventRowId(ref.entityId).subject)
        } catch {
          // Unparseable ids are refused by `mayRead`; nothing to prefetch.
        }
      } else if (ref.entity === 'pendingInteraction') {
        // The subject session is in the id; `mayRead` asks the `session` arm's
        // question about it, which reads only what this pass prefetched.
        try {
          sessionIds.add(parseInteractionRowId(ref.entityId).sessionId)
        } catch {
          // Unparseable ids are refused by `mayRead`; nothing to prefetch.
        }
      } else if (ref.entity === 'message') {
        try {
          sessionIds.add(parseMessageRecordRowId(ref.entityId).sessionId)
        } catch {
          // Unparseable ids are refused by `mayRead`; nothing to prefetch.
        }
      } else if (ref.entity === 'shipOrder') {
        shipOrderIds.add(ref.entityId)
      } else if (ref.entity === 'shipLane') {
        shipLaneIds.add(ref.entityId)
      } else if (ref.entity === 'session') {
        sessionIds.add(ref.entityId)
      } else if (ref.entity === 'conversation') {
        resumeValues.add(ref.entityId)
      } else if (ref.entity === 'automation') {
        automationIds.add(ref.entityId)
      } else if (ref.entity === 'automationRun') {
        automationRunIds.add(ref.entityId)
      } else if (ref.entity === 'effect') {
        effectIds.add(ref.entityId)
      } else if (ref.entity === 'subscription') {
        // The subscriber is in the id: its session or its task is read with the
        // rest of the pass (POD-6676).
        try {
          const { subscriberKind, subscriberId } = parseSubscriptionRowId(ref.entityId)
          if (subscriberKind === 'session') sessionIds.add(subscriberId)
          else issueIds.add(subscriberId)
        } catch {
          // Unparseable ids are refused by `mayRead`; nothing to prefetch.
        }
      } else if (ref.entity === 'workflow') {
        workflowIds.add(ref.entityId)
      } else if (ref.entity === 'workflowRevision') {
        workflowRevisionIds.add(ref.entityId)
      } else if (ref.entity === 'workflowBinding') {
        workflowBindingIds.add(ref.entityId)
      } else if (ref.entity === 'workflowRun') {
        workflowRunIds.add(ref.entityId)
      }
    }
    // Effects resolve to their targets before the issue, session and grant reads,
    // for the reason ship orders do (one read for the whole batch).
    const effectAudiences: ReadonlyMap<string, EffectAudience> =
      effectIds.size === 0
        ? new Map()
        : await measure(
            'visibility.effect.audiencesOf',
            async () => await store.effects.audiencesOf([...effectIds]),
          )
    for (const audience of effectAudiences.values()) {
      if (audience.targetKind === 'issue') issueIds.add(audience.targetId)
      else if (audience.targetKind === 'session') sessionIds.add(audience.targetId)
    }
    // A software update or a server move is every admin's (POD-6358): one read
    // of the admins, and only for a batch that holds one.
    const adminIds: ReadonlySet<string> = [...effectAudiences.values()].some((audience) =>
      INSTANCE_EFFECT_KINDS.has(audience.kind),
    )
      ? await measure('visibility.effect.adminIds', async () => await store.users.activeAdminIds())
      : new Set()
    const issueIdsByShipOrder =
      shipOrderIds.size === 0
        ? new Map<string, string>()
        : await measure(
            'visibility.shipOrder.issueIdForOrder',
            async () => await store.shipping.issueIdsForOrders([...shipOrderIds]),
          )
    for (const issueId of issueIdsByShipOrder.values()) issueIds.add(issueId)
    // One read for every lane (POD-6149); like ship orders, lanes resolve to
    // issues before the grant read.
    const issueIdsByShipLane: ReadonlyMap<string, readonly string[]> =
      shipLaneIds.size === 0
        ? new Map()
        : await measure(
            'visibility.shipLane.memberIssueIds',
            async () => await store.shipping.laneMemberIssueIdsMany(shipLaneIds),
          )
    for (const members of issueIdsByShipLane.values()) {
      for (const issueId of members) issueIds.add(issueId)
    }
    const issues =
      issueIds.size === 0
        ? new Map<string, IssueRow>()
        : await measure(
            'visibility.issue.getIssue',
            async () => await readIssues(store.issues, [...issueIds]),
          )
    // The sessions a task's private fields point at are read with the rest:
    // their owners decide who receives those pointers (POD-6288).
    for (const row of issues.values()) {
      for (const sessionId of issueExecutionSessionIds(executionPointersOf(row))) {
        sessionIds.add(sessionId)
      }
    }
    const sessions =
      sessionIds.size === 0
        ? new Map<string, SessionRow>()
        : await measure(
            'visibility.session.getSession',
            async () => await store.sessions.getSessions([...sessionIds]),
          )
    const sessionsByResumeValue =
      resumeValues.size === 0
        ? new Map<string, SessionRow>()
        : await measure(
            'visibility.conversation.findSessionByResumeValue',
            async () => await store.sessions.findSessionsByResumeValues([...resumeValues]),
          )
    // The session ids a grant question can be asked about: the ones named
    // directly, plus the ones a conversation resolved to.
    // One read per table for every automation and run in the batch (POD-6149).
    // Every asked id gets an entry, `undefined` for "no owner", as before.
    const ownersOf = async (
      ids: ReadonlySet<string>,
      label: BootstrapReadPhase,
      read: (ids: readonly string[]) => Promise<ReadonlyMap<string, UserId>>,
    ): Promise<Map<string, UserId | undefined>> => {
      if (ids.size === 0) return new Map()
      const found = await measure(label, async () => await read([...ids]))
      return new Map([...ids].map((id) => [id, found.get(id)]))
    }
    const automationOwners = await ownersOf(automationIds, 'visibility.automation.ownerOf', (ids) =>
      store.automations.ownersOf(ids),
    )
    const automationRunOwners = await ownersOf(
      automationRunIds,
      'visibility.automationRun.runOwnerOf',
      (ids) => store.automations.runOwnersOf(ids),
    )
    // The workflow kinds (POD-6676): one read per kind for their owners, one
    // grouped read of their READ grants, and the admins, only for a batch that
    // holds a workflow-family row.
    const anyWorkflowRow =
      workflowIds.size + workflowRevisionIds.size + workflowBindingIds.size + workflowRunIds.size >
      0
    const workflowFacts: WorkflowVisibilityFacts = anyWorkflowRow
      ? await measure(
          'visibility.workflow.facts',
          async () =>
            await store.workflows.visibilityFacts({
              workflowIds: [...workflowIds],
              revisionIds: [...workflowRevisionIds],
              bindings: [...workflowBindingIds].flatMap((id) => {
                const key = parseWorkflowBindingRowId(id)
                return key === undefined ? [] : [key]
              }),
              runIds: [...workflowRunIds],
            }),
        )
      : NO_WORKFLOW_FACTS
    const workflowReadGrants = new Set<string>()
    let workflowAdminIds: ReadonlySet<string> = new Set()
    if (anyWorkflowRow) {
      const definitions = new Set<string>()
      const libraryEntries = new Set<string>()
      for (const [id, row] of workflowFacts.workflows) {
        ;(row.scope === 'global' ? libraryEntries : definitions).add(id)
      }
      for (const row of workflowFacts.revisions.values()) {
        ;(row.scope === 'global' ? libraryEntries : definitions).add(row.workflowId)
      }
      const asked: Record<string, string[]> = {
        'workflow-definition': [...definitions],
        'workflow-library-entry': [...libraryEntries],
        'workflow-binding': [...workflowFacts.bindings.keys()],
        'workflow-run': [...workflowFacts.runs.keys()],
      }
      const grants = await measure(
        'visibility.workflow.grants',
        async () => await store.grants.loadForResourcesOfKinds(asked),
      )
      for (const [kind, byId] of grants) {
        for (const [id, edges] of byId) {
          for (const edge of edges) {
            if (edge.verb === 'read')
              workflowReadGrants.add(`${edge.grantee}\u0000${kind}\u0000${id}`)
          }
        }
      }
      workflowAdminIds = await measure(
        'visibility.workflow.adminIds',
        async () => await store.users.activeAdminIds(),
      )
    }
    // One grouped read for the whole batch (POD-6217): the custody edges of
    // the machines the batch's tasks are homed on. Through the operation's
    // loader (POD-6189). Issue edges are not read: tasks are shared, so a legacy
    // issue grant decides nothing (POD-6288); nor session edges (POD-6283).
    const machineIds = [
      ...new Set([...issues.values()].flatMap((row) => (row.machineId ? [row.machineId] : []))),
    ]
    const found: ReadonlyMap<
      string,
      ReadonlyMap<string, readonly GrantRow[]>
    > = machineIds.length === 0
      ? new Map()
      : await measure(
          'visibility.grants.listForResources',
          async () => await store.grants.loadForResourcesOfKinds({ machine: machineIds }),
        )
    const machineCustodians = new Map<string, UserId>()
    for (const [machineId, edges] of found.get('machine') ?? []) {
      const custodian = custodianFromEdges(edges)
      if (custodian) machineCustodians.set(machineId, custodian)
    }
    return makeVisibilityState({
      issueIds,
      issues,
      shipOrderIds,
      issueIdsByShipOrder,
      shipLaneIds,
      issueIdsByShipLane,
      sessionIds,
      sessions,
      resumeValues,
      sessionsByResumeValue,
      machineCustodians,
      automationIds,
      automationOwners,
      automationRunIds,
      automationRunOwners,
      effectAudiences,
      adminIds,
      workflowFacts,
      workflowReadGrants,
      workflowAdminIds,
    })
  }

  /** One JSON value, or `undefined` for a corrupt payload, as the bootstrap reads it. */
  const parsedPayload = (payload: string): unknown => {
    try {
      return JSON.parse(payload)
    } catch {
      return undefined
    }
  }

  /**
   * THE ROWS AN ISSUE'S AUDIENCE CHANGE RE-SCOPES, for every issue in a batch at
   * once [POD-6156].
   *
   * Read from the database for exactly these issues, where it used to be read
   * out of an index built over the whole installed world (every row of
   * `change_latest`) and rebuilt after every append. Each list is in the order
   * that index gave it: installed rows by seq, sessions in the order the
   * indexed `issue_id IN (…)` read returns them.
   *
   *   sessions        one indexed read of the issues' live sessions;
   *   dependencies    one primary-key range per issue over the installed
   *                   `issueDep` ids that start with the issue's escaped id
   *                   (`issueDepFromPrefix`), kept only where the id parses to it;
   *   ship orders     the issues' orders from `idx_ship_orders_issue` (orders
   *                   are never deleted and never change issue), then their
   *                   installed rows by key. The issue and the lane come from
   *                   the installed payload, as they always did.
   *   effects         the live records on the issues and on their sessions,
   *                   one read of `idx_effects_target` after the sessions are
   *                   known (POD-6401): an effect is read by whoever reads its
   *                   target, so it re-scopes with that target's audience.
   */
  const issueEdgeRows = async (issueIds: readonly string[]) => {
    const sessionsByIssue = new Map<string, SessionRow[]>()
    const depsByIssue = new Map<string, IssueDepSubject[]>()
    const ordersByIssue = new Map<string, ShipOrderSubject[]>()
    const lanesByIssue = new Map<string, ShipLaneSubject[]>()
    const effectsByIssue = new Map<string, EffectSubject[]>()
    if (issueIds.length === 0) {
      return { sessionsByIssue, depsByIssue, ordersByIssue, lanesByIssue, effectsByIssue }
    }
    const wanted = new Set(issueIds)
    const [sessionRows, depRows, orderIds] = await Promise.all([
      store.sessions.findSessionsByIssueIds(issueIds.map((id) => asIssueId(id))),
      store.sync.installedIdsWithPrefixes(
        'issueDep',
        issueIds.map((id) => issueDepFromPrefix(id)),
      ),
      store.shipping.orderIdsForIssues(issueIds),
    ])
    for (const row of sessionRows) {
      if (row.issueId == null) continue
      const bucket = sessionsByIssue.get(row.issueId)
      if (bucket) bucket.push(row)
      else sessionsByIssue.set(row.issueId, [row])
    }
    for (const row of [...depRows].sort((a, b) => a.seq - b.seq)) {
      const dep = parseIssueDepId(row.entityId)
      if (dep === null || !wanted.has(dep.fromId)) continue
      const subjects = depsByIssue.get(dep.fromId) ?? []
      subjects.push({ entity: 'issueDep', entityId: row.entityId })
      depsByIssue.set(dep.fromId, subjects)
    }
    // Each target's issue, and its place in that issue's list: the issue's own
    // records first, then each session's in session order.
    const placeOfTarget = new Map<string, { issueId: string; rank: number }>()
    for (const id of issueIds) placeOfTarget.set(`issue\u0000${id}`, { issueId: id, rank: 0 })
    for (const [issueId, sessions] of sessionsByIssue) {
      for (const [index, session] of sessions.entries()) {
        placeOfTarget.set(`session\u0000${session.id}`, { issueId, rank: index + 1 })
      }
    }
    const [orderRows, effectRows] = await Promise.all([
      orderIds.length === 0
        ? []
        : store.sync.installedStates(
            orderIds.map((id) => ({ entity: 'shipOrder' as const, entityId: id })),
          ),
      measure(
        'visibility.effect.liveOnTargets',
        async () =>
          await store.effects.liveOnTargets([
            ...issueIds.map((id) => ({ kind: 'issue', id })),
            ...[...sessionsByIssue.values()]
              .flat()
              .map((session) => ({ kind: 'session', id: session.id })),
          ]),
      ),
    ])
    const placed = effectRows.flatMap((row) => {
      const place = placeOfTarget.get(`${row.targetKind}\u0000${row.targetId}`)
      return place === undefined ? [] : [{ id: row.id, ...place }]
    })
    // A stable sort: within one target, the read's oldest-first order stands.
    for (const { id, issueId } of placed.sort((a, b) => a.rank - b.rank)) {
      const subjects = effectsByIssue.get(issueId) ?? []
      subjects.push({ entity: 'effect', entityId: id })
      effectsByIssue.set(issueId, subjects)
    }
    for (const row of [...orderRows].sort((a, b) => a.seq - b.seq)) {
      if (row.payload === null) continue
      const payload = parsedPayload(row.payload) as
        | {
            issueId?: unknown
            repoId?: unknown
            destination?: unknown
            targetBranch?: unknown
            state?: unknown
          }
        | null
        | undefined
      // A malformed change cannot supply a visibility anchor.
      if (payload === null || typeof payload !== 'object') continue
      if (typeof payload.issueId !== 'string' || !wanted.has(payload.issueId)) continue
      const subjects = ordersByIssue.get(payload.issueId) ?? []
      subjects.push({ entity: 'shipOrder', entityId: row.entityId })
      ordersByIssue.set(payload.issueId, subjects)
      if (
        payload.state === 'queued' &&
        typeof payload.repoId === 'string' &&
        typeof payload.destination === 'string' &&
        typeof payload.targetBranch === 'string'
      ) {
        const lanes = lanesByIssue.get(payload.issueId) ?? []
        lanes.push({
          entity: 'shipLane',
          entityId: shipLaneId(
            payload.repoId as RepoId,
            canonicalShippingDestination(payload.destination, payload.targetBranch),
          ),
        })
        lanesByIssue.set(payload.issueId, lanes)
      }
    }
    return { sessionsByIssue, depsByIssue, ordersByIssue, lanesByIssue, effectsByIssue }
  }

  /**
   * WHO LOST A LANE when an order left its queue (POD-4974 O2).
   *
   * A lane is readable by whoever may read one of its queued orders, so an order
   * that ships, starts, is held or is cancelled can take the LAST readable
   * member away from someone. The lane's own change cannot reach them — they no
   * longer pass `mayRead` — so the order's change anchors an evict for exactly
   * the people who could read this order and can read no order left in the
   * lane. Everyone else is left out of the audience: telling them the lane moved
   * would only re-send a row they already receive.
   *
   * Every order of a batch at once, in a fixed number of grouped reads
   * (POD-6156): the orders, their issues' owners and audiences, every lane's
   * members, and those members' rows and grants.
   */
  const laneDepartureEdges = async (
    orderIds: readonly string[],
  ): Promise<Map<string, VisibilityEdge | null>> => {
    const out = new Map<string, VisibilityEdge | null>(orderIds.map((id) => [id, null]))
    if (orderIds.length === 0) return out
    const departed = (await store.shipping.ordersByIds(orderIds)).filter(
      (order) => order.state !== 'queued',
    )
    if (departed.length === 0) return out
    const departedIssueIds = [...new Set(departed.map((order) => order.issueId))]
    const [owners, audiences] = await Promise.all([
      measure(
        'visibility.issue.getIssue',
        async () => await readIssues(store.issues, departedIssueIds),
      ),
      deps.audiencesFor('issue', departedIssueIds),
    ])
    const laneOf = new Map(
      departed.map((order) => [
        order.id,
        shipLaneId(
          order.repoId,
          canonicalShippingDestination(order.destination, order.targetBranch),
        ),
      ]),
    )
    const membersByLane = await store.shipping.laneMemberIssueIdsMany(laneOf.values())
    const memberIds = [...new Set([...membersByLane.values()].flat())]
    const memberRows =
      memberIds.length === 0
        ? new Map<string, IssueRow>()
        : await measure(
            'visibility.issue.getIssue',
            async () => await readIssues(store.issues, memberIds),
          )
    for (const order of departed) {
      const owner = owners.get(order.issueId)?.ownerUserId
      const candidates = [
        ...new Set([...(owner ? [owner] : []), ...(audiences.get(order.issueId) ?? [])]),
      ]
      if (candidates.length === 0) continue
      const laneId = laneOf.get(order.id) as string
      const members = membersByLane.get(laneId) ?? []
      const audience: string[] = []
      for (const userId of candidates) {
        // Every member reads every task (POD-6288), so a lane stays readable
        // while it holds any task; an empty lane is removed by its own change.
        const readable = members.some((issueId) => memberRows.has(issueId))
        if (!readable) audience.push(userId)
      }
      if (audience.length > 0) {
        out.set(order.id, { audience, subjects: [{ entity: 'shipLane', entityId: laneId }] })
      }
    }
    return out
  }

  /**
   * WHO GAINED OR LOST A MACHINE'S WORKTREE PATHS (POD-6291, design §4.5).
   *
   * The custodian of a machine receives the worktree path and machine of every
   * task homed there; everyone else receives the task without them (§4.2). A
   * custody change therefore moves those fields between people while the task
   * rows stay byte-identical, so no task change would ever carry it. The
   * machine's row names its custodian, and its change anchors the tasks with a
   * live worktree there for everyone who held a grant on the machine
   * (`grant_audiences`, revoked custodians included) and for those tasks'
   * assignees (who receive the fields while nobody holds custody). Each of
   * them gets the task re-shaped as they may now see it: the path is gone from
   * a former custodian's clients, and nothing is deleted.
   */
  const custodyEdges = async (
    machineIds: readonly string[],
  ): Promise<Map<string, VisibilityEdge | null>> => {
    const out = new Map<string, VisibilityEdge | null>(machineIds.map((id) => [id, null]))
    if (machineIds.length === 0) return out
    const [tasks, audiences] = await Promise.all([
      store.issues.liveWorktreeIssuesOnMachines(machineIds),
      deps.audiencesFor('machine', machineIds),
    ])
    for (const machineId of machineIds) {
      const homed = tasks.get(machineId) ?? []
      if (homed.length === 0) continue
      const audience = [
        ...new Set([...(audiences.get(machineId) ?? []), ...homed.map((task) => task.ownerUserId)]),
      ]
      out.set(machineId, {
        audience,
        subjects: homed.map((task) => ({ entity: 'issueProjection' as const, entityId: task.id })),
      })
    }
    return out
  }

  const anchors: VisibilityAnchorPort = {
    visibilityEdges: async (refs) => {
      // An issue write is the audience-change edge for its normalized companions;
      // a ship order leaving its queue can take a lane away. Nothing else anchors.
      const issueIds = [
        ...new Set(
          refs.filter((ref) => ref.entity === 'issueProjection').map((ref) => ref.entityId),
        ),
      ]
      const orderIds = [
        ...new Set(refs.filter((ref) => ref.entity === 'shipOrder').map((ref) => ref.entityId)),
      ]
      const machineIds = [
        ...new Set(refs.filter((ref) => ref.entity === 'machine').map((ref) => ref.entityId)),
      ]
      const [audiences, departures, custody] = await Promise.all([
        issueIds.length === 0
          ? new Map<string, readonly string[]>()
          : deps.audiencesFor('issue', issueIds),
        laneDepartureEdges(orderIds),
        custodyEdges(machineIds),
      ])
      // Only an issue with an audience can produce an edge; read for those only.
      const anchored = issueIds.filter((id) => (audiences.get(id) ?? []).length > 0)
      const rows = await issueEdgeRows(anchored)
      return refs.map((ref): VisibilityEdge | null => {
        if (ref.entity === 'shipOrder') return departures.get(ref.entityId) ?? null
        if (ref.entity === 'machine') return custody.get(ref.entityId) ?? null
        if (ref.entity !== 'issueProjection') return null
        const audience = audiences.get(ref.entityId) ?? []
        if (audience.length === 0) return null
        const issueSessions = rows.sessionsByIssue.get(ref.entityId) ?? []
        return {
          audience,
          subjects: [
            { entity: 'issueProjection' as const, entityId: ref.entityId },
            { entity: 'issueGitState' as const, entityId: ref.entityId },
            ...issueSessions.map((session) => ({
              entity: 'session' as const,
              entityId: session.id,
            })),
            ...issueSessions.flatMap((session) =>
              session.resumeValue
                ? [{ entity: 'conversation' as const, entityId: session.resumeValue }]
                : [],
            ),
            ...(rows.depsByIssue.get(ref.entityId) ?? []),
            // The issue's feed history rides its audience (POD-1772): a grant that
            // hands somebody the issue and none of its events would give them a
            // chat pane that starts at the moment they were let in.
            ...(deps.issueEventSubjects?.(asIssueId(ref.entityId)) ?? []),
            ...(rows.ordersByIssue.get(ref.entityId) ?? []),
            // The lanes of its queued orders: a grant can make a lane readable and a
            // revoke can take the last readable order in it away (POD-4974 O2).
            ...(rows.lanesByIssue.get(ref.entityId) ?? []),
            // Its effect records and its sessions' (POD-6401): a merge's status is
            // read by whoever reads the issue, so a grant hands it over at once.
            ...(rows.effectsByIssue.get(ref.entityId) ?? []),
          ],
        }
      })
    },
    /** Every subject's installed value in one grouped read (POD-6156). */
    currentValuesOf: async (refs) => {
      if (refs.length === 0) return []
      const byKey = new Map<string, string>()
      for (const row of await store.sync.installedStates(refs)) {
        if (row.payload !== null) byKey.set(`${row.entity}\u0000${row.entityId}`, row.payload)
      }
      return refs.map((ref) => {
        const payload = byKey.get(`${ref.entity}\u0000${ref.entityId}`)
        return payload === undefined ? undefined : parsedPayload(payload)
      })
    },
  }

  return {
    state: makeVisibilityState(),
    anchors,
    beginBootstrapRead,
    finishBootstrapRead,
    authorizationRevision: deps.authorizationRevision,
    mayReadIssue: (userId, issueId) => mayReadIssue(userId, issueId),
  }
}
