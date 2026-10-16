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
  type IssueId,
  issueDepFromPrefix,
  parseInteractionRowId,
  parseIssueDepId,
  parseIssueEventRowId,
  parseIssueUserStateRowId,
  parseLayoutRowId,
  parseMessageRecordRowId,
  parseReadPositionRowId,
  parseSessionUserStateRowId,
  type RepoId,
  shipLaneId,
  type UserId,
} from '@podium/model'
import type { Principal } from '@podium/protocol'
import type {
  EntityRef,
  VisibilityAnchorPort,
  VisibilityEdge,
  VisibilityStatePort,
} from '@podium/sync'
import type { FeedVisibilityStore, GrantRow, IssueRow, SessionRow } from './hot-path-ports'
import { perfPrincipal } from './modules/perf/principal'
import { perf } from './modules/perf/registry'

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
  | 'visibility.shipOrder.issueIdForOrder'
  | 'visibility.shipLane.memberIssueIds'
  | 'visibility.grants.listForResources'

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
  readonly issueGrants: ReadonlyMap<string, readonly GrantRow[]>
  readonly sessionGrants: ReadonlyMap<string, readonly GrantRow[]>
  readonly automationIds: ReadonlySet<string>
  readonly automationOwners: ReadonlyMap<string, UserId | undefined>
  readonly automationRunIds: ReadonlySet<string>
  readonly automationRunOwners: ReadonlyMap<string, UserId | undefined>
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

  const issueGrantAdmits = (edge: GrantRow, userId: string): boolean =>
    edge.grantee === userId &&
    (edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage')
  const sessionGrantAdmits = (edge: GrantRow, userId: string): boolean =>
    edge.grantee === userId && edge.verb === 'read'
  const mayReadIssue = async (userId: UserId, issueId: IssueId): Promise<boolean> => {
    // The repository commit installs the owned row map before publication.
    // Open mutation spans still read their own writes through the live fallback.
    const row = await measure(
      'visibility.issue.getIssue',
      async () => await readIssue(store.issues, issueId),
    )
    if (row?.ownerUserId === userId) return true
    return (await store.grants.loadForResource('issue', issueId)).some((edge) =>
      issueGrantAdmits(edge, userId),
    )
  }

  const mayReadIssueFromSnapshot = (
    userId: string,
    issueId: string,
    snapshot: BootstrapVisibilityPrefetch,
  ): boolean => {
    if (!snapshot.issueIds.has(issueId)) return false
    if (snapshot.issues.get(issueId)?.ownerUserId === userId) return true

    return (snapshot.issueGrants.get(issueId) ?? []).some((edge) => issueGrantAdmits(edge, userId))
  }

  const makeVisibilityState = (prefetch?: BootstrapVisibilityPrefetch): VisibilityStatePort => {
    /** MAY THIS PERSON SEE THIS SESSION — owner, or a read grant on it.
     *
     *  Extracted (POD-2020) because `pendingInteraction` answers the same question
     *  about the session named in its row id, and two copies of a visibility rule
     *  is one copy that eventually says yes when the other says no. The body is
     *  the `session` arm's, unchanged, perf label included. */
    const maySeeSession = (userId: string, sessionId: string): boolean => {
      if (!prefetch?.sessionIds.has(sessionId)) return false
      if (prefetch.sessions.get(sessionId)?.ownerUserId === userId) return true
      return (prefetch.sessionGrants.get(sessionId) ?? []).some((edge) =>
        sessionGrantAdmits(edge, userId),
      )
    }
    return {
      classOf: (entity) => {
        if (entity === 'repo' || entity === 'machine') return 'deployment-substrate'
        // Per-user shell layout (POD-1350): never grantable; keyedUserOf owns the
        // filter. Must NOT fall through to personal or unclassified.
        if (entity === 'userLayout') return 'per-user-state'
        // Per-user read positions (POD-1380): same class, same reason. A cursor
        // that fell through to `personal` would be grantable, and "share my read
        // state" is not a verb — it is the privacy defect this member exists to
        // avoid.
        if (entity === 'userReadPosition') return 'per-user-state'
        if (entity === 'issueUserState' || entity === 'sessionUserState') return 'per-user-state'
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
          entity === 'automationRun'
        )
          return 'personal'
        return null
      },
      mayRead: (userId, ref) => {
        if (userId === 'device:shared-instance-password') return true
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
          if (!row) return false
          if (row.ownerUserId === userId) return true
          return (prefetch.sessionGrants.get(row.id) ?? []).some((edge) =>
            sessionGrantAdmits(edge, userId),
          )
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
        if (ref.entity !== 'userLayout') return null
        try {
          return parseLayoutRowId(ref.entityId).userId
        } catch {
          return null
        }
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
      }
    }
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
    const grantedSessionIds = new Set<string>(sessionIds)
    for (const row of sessionsByResumeValue.values()) grantedSessionIds.add(row.id)
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
    // One grouped read per resource kind for the whole batch; every asked id
    // gets an entry, `[]` for "no edges".
    const grantsOf = async (
      kind: 'issue' | 'session',
      ids: ReadonlySet<string>,
    ): Promise<Map<string, readonly GrantRow[]>> => {
      if (ids.size === 0) return new Map()
      const found = await measure(
        'visibility.grants.listForResources',
        async () => await store.grants.listForResources(kind, [...ids]),
      )
      return new Map([...ids].map((id) => [id, found.get(id) ?? []]))
    }
    const issueGrants = await grantsOf('issue', issueIds)
    const sessionGrants = await grantsOf('session', grantedSessionIds)
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
      issueGrants,
      sessionGrants,
      automationIds,
      automationOwners,
      automationRunIds,
      automationRunOwners,
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
   */
  const issueEdgeRows = async (issueIds: readonly string[]) => {
    const sessionsByIssue = new Map<string, SessionRow[]>()
    const depsByIssue = new Map<string, IssueDepSubject[]>()
    const ordersByIssue = new Map<string, ShipOrderSubject[]>()
    const lanesByIssue = new Map<string, ShipLaneSubject[]>()
    if (issueIds.length === 0) return { sessionsByIssue, depsByIssue, ordersByIssue, lanesByIssue }
    const wanted = new Set(issueIds)
    const [sessionRows, depRows, orderIds] = await Promise.all([
      store.sessions.findSessionsByIssueIds(issueIds.map((id) => asIssueId(id))),
      store.sync.installedIdsWithPrefixes('issueDep', issueIds.map((id) => issueDepFromPrefix(id))),
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
    const orderRows =
      orderIds.length === 0
        ? []
        : await store.sync.installedStates(
            orderIds.map((id) => ({ entity: 'shipOrder' as const, entityId: id })),
          )
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
    return { sessionsByIssue, depsByIssue, ordersByIssue, lanesByIssue }
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
    const departed = (await store.shipping.ordersByIds(orderIds)).filter((order) => order.state !== 'queued')
    if (departed.length === 0) return out
    const departedIssueIds = [...new Set(departed.map((order) => order.issueId))]
    const [owners, audiences] = await Promise.all([
      measure('visibility.issue.getIssue', async () => await readIssues(store.issues, departedIssueIds)),
      deps.audiencesFor('issue', departedIssueIds),
    ])
    const laneOf = new Map(
      departed.map((order) => [
        order.id,
        shipLaneId(order.repoId, canonicalShippingDestination(order.destination, order.targetBranch)),
      ]),
    )
    const membersByLane = await store.shipping.laneMemberIssueIdsMany(laneOf.values())
    const memberIds = [...new Set([...membersByLane.values()].flat())]
    const [memberRows, memberGrants] =
      memberIds.length === 0
        ? [new Map<string, IssueRow>(), new Map<string, GrantRow[]>()]
        : await Promise.all([
            measure('visibility.issue.getIssue', async () => await readIssues(store.issues, memberIds)),
            measure(
              'visibility.grants.listForResources',
              async () => await store.grants.listForResources('issue', memberIds),
            ),
          ])
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
        const readable = members.some(
          (issueId) =>
            memberRows.get(issueId)?.ownerUserId === userId ||
            (memberGrants.get(issueId) ?? []).some((edge) => issueGrantAdmits(edge, userId)),
        )
        if (!readable) audience.push(userId)
      }
      if (audience.length > 0) {
        out.set(order.id, { audience, subjects: [{ entity: 'shipLane', entityId: laneId }] })
      }
    }
    return out
  }

  const anchors: VisibilityAnchorPort = {
    visibilityEdges: async (refs) => {
      // An issue write is the audience-change edge for its normalized companions;
      // a ship order leaving its queue can take a lane away. Nothing else anchors.
      const issueIds = [
        ...new Set(refs.filter((ref) => ref.entity === 'issueProjection').map((ref) => ref.entityId)),
      ]
      const orderIds = [
        ...new Set(refs.filter((ref) => ref.entity === 'shipOrder').map((ref) => ref.entityId)),
      ]
      const [audiences, departures] = await Promise.all([
        issueIds.length === 0
          ? new Map<string, readonly string[]>()
          : deps.audiencesFor('issue', issueIds),
        laneDepartureEdges(orderIds),
      ])
      // Only an issue with an audience can produce an edge; read for those only.
      const anchored = issueIds.filter((id) => (audiences.get(id) ?? []).length > 0)
      const rows = await issueEdgeRows(anchored)
      return refs.map((ref): VisibilityEdge | null => {
        if (ref.entity === 'shipOrder') return departures.get(ref.entityId) ?? null
        if (ref.entity !== 'issueProjection') return null
        const audience = audiences.get(ref.entityId) ?? []
        if (audience.length === 0) return null
        const issueSessions = rows.sessionsByIssue.get(ref.entityId) ?? []
        return {
          audience,
          subjects: [
            { entity: 'issueProjection' as const, entityId: ref.entityId },
            { entity: 'issueGitState' as const, entityId: ref.entityId },
            ...issueSessions.map((session) => ({ entity: 'session' as const, entityId: session.id })),
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
