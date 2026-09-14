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
 * It is one job with one piece of protected state each: `traces` is the stack a
 * bootstrap pushes so every store read it causes is attributed to a phase, and
 * `readCache` is the generation-keyed index the anchor port walks. Neither
 * escapes this module, and nothing here reaches back into a service — the whole
 * surface is store reads.
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
  parseIssueDepId,
  parseIssueEventRowId,
  parseInteractionRowId,
  parseLayoutRowId,
  parseReadPositionRowId,
  type IssueId,
  type UserId,
  type SessionId,
} from '@podium/model'
import type { Principal } from '@podium/protocol'
import type {
  ChangeLogReadRow,
  EntityRef,
  VisibilityAnchorPort,
  VisibilityStatePort,
} from '@podium/sync'
import { perfPrincipal } from './modules/perf/principal'
import { perf } from './modules/perf/registry'
import type { GrantRow } from './hot-path-ports'
import type { WorldIndexReader } from './modules/world-index'
import type { IssueRow, SessionRow, FeedVisibilityStore } from './hot-path-ports'

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
  readonly sessionIds: ReadonlySet<string>
  readonly sessions: ReadonlyMap<string, SessionRow>
  readonly resumeValues: ReadonlySet<string>
  readonly sessionsByResumeValue: ReadonlyMap<string, SessionRow>
  /** Committed grant edges, copied from the world index for this pass.
   * ID sets distinguish an empty answer from an unprepared ref. Preparation
   * runs after commit for delta publication; no read-your-writes is required.
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

type BootstrapReadCache = {
  generation: number
  latestByRef: Map<string, Map<string, ChangeLogReadRow>>
  issueDepsByFromId: Map<string, IssueDepSubject[]>
  shipOrdersByIssueId: Map<string, ShipOrderSubject[]>
}

/** The store surface this policy reads. Nothing here writes. */
export interface FeedVisibilityDeps {
  readonly store: FeedVisibilityStore
  readonly worldIndex: WorldIndexReader
  /** Historical audiences include revoked readers; current edges cannot replace
   * them. These existing memory-only signals remain owned by the grant writer. */
  readonly audienceResourceIds: (kind: string) => Promise<string[]>
  readonly audienceFor: (kind: string, id: string) => Promise<readonly string[]>
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
  const { store, worldIndex } = deps

  const traces: BootstrapReadTrace[] = []
  const measure = async <T>(
    phase: BootstrapReadPhase,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
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
  const mayReadIssue = async (
    userId: UserId,
    issueId: IssueId,
  ): Promise<boolean> => {
    // Authority publishes after the transaction commits but before IssueService
    // installs a newly-created row in its live map. Read the durable row here so
    // the creation frame is scoped from the same committed truth catch-up sees.
    const row = await measure('visibility.issue.getIssue', async () =>
      await store.issues.getIssue(issueId),
    )
    if (row?.ownerUserId === userId) return true
    return worldIndex.grantsFor('issue', issueId).some((edge) =>
      issueGrantAdmits(edge, userId),
    )
  }

  /**
   * **MAY THIS PERSON SEE THE PRIVATE EXECUTION HALF OF THIS ISSUE** — the
   * OWNER, and nobody else [B4, PDM-136].
   *
   * THE ABSENCE OF A GRANT TERM IS THE ENTIRE POINT OF THIS FUNCTION, and it is
   * why it is written out here rather than expressed as
   * `mayReadIssueFromSnapshot` with an argument. The four keys it governs —
   * `worktreePath`, `machineId`, `coordinatorSessionId`, `startedBySession` —
   * were moved off the shared issue payloads precisely so that C4 (PDM-144),
   * which replaces the issue READ predicate with the active-member class policy,
   * cannot widen them. Route this through the read predicate and the sidecar
   * widens on exactly the commit the shared payload does, and the split has
   * bought nothing while every test still passes.
   *
   * So: no grant term, no audience term, no call into the read predicate. An
   * issue GRANT deliberately does not carry the private half — ADR 9 Am.1 D13
   * limits what a shared task exposes to owner, title and live/idle state, and
   * an absolute path on one human's machine is none of those.
   */
  const mayReadIssueExecutionFromSnapshot = (
    userId: string,
    issueId: string,
    snapshot: BootstrapVisibilityPrefetch,
  ): boolean => {
    if (!snapshot.issueIds.has(issueId)) return false
    return snapshot.issues.get(issueId)?.ownerUserId === userId
  }

  const mayReadIssueFromSnapshot = (
    userId: string,
    issueId: string,
    snapshot: BootstrapVisibilityPrefetch,
  ): boolean => {
    if (!snapshot.issueIds.has(issueId)) return false
    if (snapshot.issues.get(issueId)?.ownerUserId === userId) return true

    return (snapshot.issueGrants.get(issueId) ?? []).some((edge) =>
      issueGrantAdmits(edge, userId),
    )
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
        if (entity === 'repo') return 'deployment-substrate'
        // Per-user shell layout (POD-1350): never grantable; keyedUserOf owns the
        // filter. Must NOT fall through to personal or unclassified.
        if (entity === 'userLayout') return 'per-user-state'
        // Per-user read positions (POD-1380): same class, same reason. A cursor
        // that fell through to `personal` would be grantable, and "share my read
        // state" is not a verb — it is the privacy defect this member exists to
        // avoid.
        if (entity === 'userReadPosition') return 'per-user-state'
        if (
          entity === 'session' ||
          entity === 'issue' ||
          entity === 'issueProjection' ||
          // The owner-scoped private half of an issue [B4, PDM-136]. `personal`
          // and not a class of its own for the same reason `issueEvent` is not:
          // the class says how the row is DECIDED (owner or grant edge), and the
          // narrowing that matters here is in `mayRead`'s arm, which resolves
          // the owner and consults no grant at all.
          entity === 'issueExecution' ||
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
          entity === 'shipOrder' ||
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
        // Checked BEFORE the issue arm, and deliberately not folded into it:
        // the two kinds are keyed by the same id and a reader skimming one arm
        // covering three kinds would not see that one of them is owner-only.
        if (ref.entity === 'issueExecution') {
          return mayReadIssueExecutionFromSnapshot(userId, ref.entityId, prefetch)
        }
        if (ref.entity === 'issue' || ref.entity === 'issueProjection') {
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
        if (ref.entity === 'pendingInteraction') {
          try {
            return maySeeSession(userId, parseInteractionRowId(ref.entityId).sessionId)
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
    const sessionIds = new Set<string>()
    const resumeValues = new Set<string>()
    const automationIds = new Set<string>()
    const automationRunIds = new Set<string>()
    for (const ref of refs) {
      if (
        ref.entity === 'issue' ||
        ref.entity === 'issueProjection' ||
        // The owner-scoped sidecar is keyed BY the issue id and its owner check
        // reads the same row [B4, PDM-136]. Prefetch it here or
        // `mayReadIssueExecutionFromSnapshot` denies every owner for want of a
        // row rather than for want of a right — a fail-closed denial that would
        // look exactly like the policy working.
        ref.entity === 'issueExecution'
      ) {
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
      } else if (ref.entity === 'shipOrder') {
        shipOrderIds.add(ref.entityId)
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
        : await measure('visibility.shipOrder.issueIdForOrder', async () =>
            await store.shipping.issueIdsForOrders([...shipOrderIds]),
          )
    for (const issueId of issueIdsByShipOrder.values()) issueIds.add(issueId)
    const issues =
      issueIds.size === 0
        ? new Map<string, IssueRow>()
        : await measure('visibility.issue.getIssue', async () => await store.issues.getIssues([...issueIds]))
    const sessions =
      sessionIds.size === 0
        ? new Map<string, SessionRow>()
        : await measure('visibility.session.getSession', async () =>
            await store.sessions.getSessions([...sessionIds]),
          )
    const sessionsByResumeValue =
      resumeValues.size === 0
        ? new Map<string, SessionRow>()
        : await measure('visibility.conversation.findSessionByResumeValue', async () =>
            await store.sessions.findSessionsByResumeValues([...resumeValues]),
          )
    // The session ids a grant question can be asked about: the ones named
    // directly, plus the ones a conversation resolved to.
    const grantedSessionIds = new Set<string>(sessionIds)
    for (const row of sessionsByResumeValue.values()) grantedSessionIds.add(row.id)
    const automationOwners = new Map<string, UserId | undefined>()
    for (const id of automationIds) {
      automationOwners.set(
        id,
        await measure('visibility.automation.ownerOf', async () =>
          await store.automations.ownerOf(id),
        ),
      )
    }
    const automationRunOwners = new Map<string, UserId | undefined>()
    for (const id of automationRunIds) {
      automationRunOwners.set(
        id,
        await measure('visibility.automationRun.runOwnerOf', async () =>
          await store.automations.runOwnerOf(id),
        ),
      )
    }
    const issueGrants = new Map(
      [...issueIds].map((id) => [id, worldIndex.grantsFor('issue', id)]),
    )
    const sessionGrants = new Map(
      [...grantedSessionIds].map((id) => [id, worldIndex.grantsFor('session', id)]),
    )
    return makeVisibilityState({
      issueIds,
      issues,
      shipOrderIds,
      issueIdsByShipOrder,
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

  let readCache: { generation: number; value: Promise<BootstrapReadCache> } | undefined
  const currentBootstrapReadCache = async (): Promise<BootstrapReadCache> => {
    const generation = await store.sync.latestChangeStatesGeneration()
    if (readCache?.generation === generation) return readCache.value
    // Publish the in-flight fill before concurrent anchors can start another.
    const value = buildBootstrapReadCache(generation)
    const entry = { generation, value }
    readCache = entry
    try {
      return await value
    } catch (error) {
      if (readCache === entry) readCache = undefined
      throw error
    }
  }
  const buildBootstrapReadCache = async (generation: number): Promise<BootstrapReadCache> => {
    const latestByRef = new Map<string, Map<string, ChangeLogReadRow>>()
    const issueDepsByFromId = new Map<string, IssueDepSubject[]>()
    const shipOrdersByIssueId = new Map<string, ShipOrderSubject[]>()
    for (const row of await store.sync.latestChangeStates()) {
      const byEntity = latestByRef.get(row.entity) ?? new Map<string, ChangeLogReadRow>()
      byEntity.set(row.entityId, row)
      latestByRef.set(row.entity, byEntity)
      if (row.entity === 'issueDep' && row.op === 'upsert') {
        const dep = parseIssueDepId(row.entityId)
        if (dep !== null) {
          const subjects = issueDepsByFromId.get(dep.fromId) ?? []
          subjects.push({ entity: 'issueDep', entityId: row.entityId })
          issueDepsByFromId.set(dep.fromId, subjects)
        }
      }
      if (row.entity === 'shipOrder' && row.op === 'upsert' && row.payload !== null) {
        try {
          const payload = JSON.parse(row.payload) as { issueId?: unknown }
          if (typeof payload.issueId !== 'string') continue
          const subjects = shipOrdersByIssueId.get(payload.issueId) ?? []
          subjects.push({ entity: 'shipOrder', entityId: row.entityId })
          shipOrdersByIssueId.set(payload.issueId, subjects)
        } catch {
          // A malformed change cannot supply a visibility anchor.
        }
      }
    }
    return {
      generation,
      latestByRef,
      issueDepsByFromId,
      shipOrdersByIssueId,
    }
  }
  const durableChangeValueOf = async (ref: { entity: string; entityId: string }): Promise<unknown> => {
    const row = (await currentBootstrapReadCache()).latestByRef.get(ref.entity)?.get(ref.entityId)
    if (row?.op !== 'upsert' || row.payload === null) return undefined
    try {
      return JSON.parse(row.payload)
    } catch {
      return undefined
    }
  }

  const anchors: VisibilityAnchorPort = {
    visibilityEdge: async (ref) => {
      // Session grants ride the SESSION audience. Putting `session` /
      // `conversation` on the issue edge named those ids (and the resume
      // value) in an `evict` to every issue grantee who may not read the
      // session — B3.2. An issue grant does not move session visibility
      // (PDM-251), so those subjects could never produce a legitimate upsert
      // for that reader. They also could not re-admit a session grantee who
      // is not already in the issue audience.
      if (ref.entity === 'session') {
        const audience = await deps.audienceFor('session', ref.entityId)
        if (audience.length === 0) return null
        const rows = await measure('visibility.session.getSession', async () =>
          await store.sessions.getSessions([ref.entityId]),
        )
        const session = rows.get(ref.entityId)
        return {
          audience,
          subjects: [
            { entity: 'session' as const, entityId: ref.entityId },
            ...(session?.resumeValue
              ? [{ entity: 'conversation' as const, entityId: session.resumeValue }]
              : []),
          ],
        }
      }
      if (ref.entity !== 'issue') return null
      const audience = await deps.audienceFor('issue', ref.entityId)
      if (audience.length === 0) return null
      const cache = await currentBootstrapReadCache()
      const subjects = [
        { entity: 'issue' as const, entityId: ref.entityId },
        { entity: 'issueProjection' as const, entityId: ref.entityId },
        // The owner-scoped half rides the issue's anchor [B4, PDM-136]. It must:
        // `anchorFor` re-decides per subject, so a reader who is not the owner
        // gets an `evict` for a row they never held and the OWNER gets the
        // upsert. Leaving it off the anchor would mean an ownership change
        // moved the shared half and left the private half where it was.
        { entity: 'issueExecution' as const, entityId: ref.entityId },
        ...(cache.issueDepsByFromId.get(ref.entityId) ?? []),
        // The issue's feed history rides its audience (POD-1772): a grant that
        // hands somebody the issue and none of its events would give them a
        // chat pane that starts at the moment they were let in.
        ...(deps.issueEventSubjects?.(asIssueId(ref.entityId)) ?? []),
        ...(cache.shipOrdersByIssueId.get(ref.entityId) ?? []),
      ]
      return { audience, subjects }
    },
    currentValueOf: async (ref) => await durableChangeValueOf(ref),
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
