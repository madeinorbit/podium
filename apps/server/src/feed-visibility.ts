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
  asSessionId,
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
import type { GrantRow } from './store/grants'
import type { IssueRow, SessionRow, SessionStore } from './store'

/**
 * The store reads a feed bootstrap can cause, named so each is separately
 * attributable. These are the strings `feedBootstrap.<phase>` is built from —
 * renaming one renames a perf series.
 */
type BootstrapReadPhase =
  | 'visibility.issue.getIssue'
  | 'visibility.issue.grants.listForResource'
  | 'visibility.session.getSession'
  | 'visibility.session.grants.listForResource'
  | 'visibility.conversation.findSessionByResumeValue'
  | 'visibility.conversation.grants.listForResource'
  | 'visibility.automation.ownerOf'
  | 'visibility.automationRun.runOwnerOf'
  | 'visibility.shipOrder.issueIdForOrder'

interface BootstrapReadTrace {
  readonly phases: Map<BootstrapReadPhase, number>
}

/**
 * Rows the bootstrap pass already fetched in bulk. Present only on the state
 * built by `forBootstrap`; the root port has none and reads row by row.
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
  /**
   * THE GRANT EDGES THE PASS WILL CONSULT, READ ONCE [POD-3261].
   *
   * The single largest remaining per-row read on this path: an owner check that
   * misses falls through to `grants.listForResource`, once per subject per
   * principal. On the measured feed bootstrap that is 9 of the 44 queries, and
   * on a remote database every one of them is a round trip.
   *
   * `store.grants.listForResources` is the SAME LIVE READ asked about many
   * resources at once — its own header says so, and rules a cache out for the
   * same reason this is not one: the rows are read from the database at the
   * moment of asking, and the map is discarded with the pass. What changes is
   * how many round trips one pass costs, not when the rights were read.
   *
   * The ID SETS are what say "looked at and found nothing" — a resource with no
   * edges has no entry in the map, so the set is the only thing that separates
   * an empty answer from an unprepared ref. A ref outside the set falls through
   * to the live point read, which is the contract `VisibilityStatePort.forBatch`
   * states.
   *
   * THE READ IS LAZY, AND THAT IS NOT AN OPTIMISATION DETAIL — it is what makes
   * this monotonic. The grant question is only reached when the OWNER check
   * misses, and on a corpus with no sharing it never is: a pass over rows the
   * asking principal owns asked ZERO grant queries before this existed, so an
   * eager prefetch would make that pass cost one or two MORE. Measured on the
   * hot-path fixture, that is exactly what it did — feed bootstrap 44 → 46.
   * Deferring to the first grant question makes the prepared form cost nothing
   * where the point reads cost nothing, and one query where they cost one per
   * row, which is the only shape that cannot lose.
   *
   * Deferring does not move the read out of the pass: the thunk is called from
   * inside `decide`, under the same lease, and the map is discarded with the
   * pass. If anything it is the more conservative reading of spec §3.5 — the
   * rights are read at the first decision that needs them rather than before any
   * decision has been taken.
   */
  readonly issueGrantIds: ReadonlySet<string>
  readonly issueGrants: () => ReadonlyMap<string, readonly GrantRow[]>
  readonly sessionGrantIds: ReadonlySet<string>
  readonly sessionGrants: () => ReadonlyMap<string, readonly GrantRow[]>
}

/** Run `load` at most once, on the first ask. See the grant-list note above. */
function onFirstAsk<T>(load: () => T): () => T {
  let held: T | undefined
  let loaded = false
  return () => {
    if (!loaded) {
      held = load()
      loaded = true
    }
    return held as T
  }
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
  /**
   * The sessions bound to each anchorable issue, filled in ONE query [POD-3261].
   *
   * It used to be the WHOLE `sessions` table — `loadSessions()`, 49 columns of
   * every live row, mapped into objects — filtered in memory to the handful
   * bound to the issue in hand. Same generation key, same cached lifetime, and
   * the same conserved quantity of ONE session read per generation; what changed
   * is that the read is the indexed `issue_id IN (…)` lookup that answers the
   * question actually being asked.
   *
   * ITS SIZE COMES FROM THE AUDIENCE MAP, not from the batch. Only an issue with
   * a non-empty visibility audience can produce an edge at all — the caller
   * returns `null` above otherwise — so the ids worth fetching are exactly
   * `grants.visibilityAudienceResourceIds('issue')`, which is an in-memory read
   * and costs nothing. `covered` records which ids that fill covered, because an
   * absent entry has to mean "this issue has no sessions" and not "the fill
   * happened before this issue had an audience"; an uncovered id falls through
   * to its own point read.
   *
   * `findSessionsByIssueIds` applies exactly the `deleted_at IS NULL` filter
   * `loadSessions` applied, so the row set is the one the filter returned.
   */
  sessionsByIssue?: {
    readonly covered: Set<string>
    readonly byIssueId: Map<string, SessionRow[]>
  }
}

/** The store surface this policy reads. Nothing here writes. */
export interface FeedVisibilityDeps {
  readonly store: SessionStore
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
  readonly authorizationRevision: () => number
  /**
   * "May this user read this issue?", exported because the mail policy's
   * resolution-time ceiling asks the same question the feed does and a second
   * copy of that answer is how the two quietly stop agreeing.
   */
  readonly mayReadIssue: (userId: UserId, issueId: IssueId) => boolean
}

export function makeFeedVisibility(deps: FeedVisibilityDeps): FeedVisibility {
  const { store } = deps

  const traces: BootstrapReadTrace[] = []
  const measure = <T>(phase: BootstrapReadPhase, fn: () => T): T => {
    const trace = traces[traces.length - 1]
    if (trace === undefined) return fn()
    const startedAt = performance.now()
    try {
      return fn()
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

  const readIssue = (issueId: IssueId, prefetch?: BootstrapVisibilityPrefetch): IssueRow | null => {
    if (prefetch?.issueIds.has(issueId)) return prefetch.issues.get(issueId) ?? null
    return measure('visibility.issue.getIssue', () => store.issues.getIssue(issueId))
  }

  const readSession = (
    sessionId: SessionId,
    prefetch?: BootstrapVisibilityPrefetch,
  ): SessionRow | undefined => {
    if (prefetch?.sessionIds.has(sessionId)) return prefetch.sessions.get(sessionId)
    return measure('visibility.session.getSession', () =>
      store.sessions.getSession(asSessionId(sessionId)),
    )
  }

  const readShipOrderIssueId = (
    orderId: string,
    prefetch?: BootstrapVisibilityPrefetch,
  ): string | null => {
    if (prefetch?.shipOrderIds.has(orderId)) {
      return prefetch.issueIdsByShipOrder.get(orderId) ?? null
    }
    return measure('visibility.shipOrder.issueIdForOrder', () =>
      store.shipping.issueIdForOrder(orderId),
    )
  }

  const readConversationSession = (
    resumeValue: string,
    prefetch?: BootstrapVisibilityPrefetch,
  ): SessionRow | undefined => {
    if (prefetch?.resumeValues.has(resumeValue)) {
      return prefetch.sessionsByResumeValue.get(resumeValue)
    }
    return measure('visibility.conversation.findSessionByResumeValue', () =>
      store.sessions.findSessionByResumeValue(resumeValue),
    )
  }

  /**
   * A session read grant, from the prefetch when the pass prepared one.
   *
   * ONE FUNCTION FOR TWO ARMS, and that is the point: `session` and
   * `conversation` ask the same question about the same resource kind, and two
   * copies of a visibility rule is one copy that eventually says yes when the
   * other says no (the argument `maySeeSession` was extracted under, POD-2020).
   * The perf phase stays per arm, because the two are separately attributable
   * series and renaming one renames a chart.
   */
  const sessionGrantAdmits = (
    sessionId: string,
    userId: string,
    prefetch: BootstrapVisibilityPrefetch | undefined,
    arm: 'session' | 'conversation' = 'session',
  ): boolean => {
    const admits = (edge: GrantRow): boolean => edge.grantee === userId && edge.verb === 'read'
    if (prefetch?.sessionGrantIds.has(sessionId)) {
      return (prefetch.sessionGrants().get(sessionId) ?? []).some(admits)
    }
    const phase =
      arm === 'session'
        ? ('visibility.session.grants.listForResource' as const)
        : ('visibility.conversation.grants.listForResource' as const)
    return measure(phase, () => store.grants.listForResource('session', sessionId).some(admits))
  }

  const mayReadIssue = (
    userId: UserId,
    issueId: IssueId,
    prefetch?: BootstrapVisibilityPrefetch,
  ): boolean => {
    // Authority publishes after the transaction commits but before IssueService
    // installs a newly-created row in its live map. Read the durable row here so
    // the creation frame is scoped from the same committed truth catch-up sees.
    const row = readIssue(issueId, prefetch)
    if (row?.ownerUserId === userId) return true
    const admits = (edge: GrantRow): boolean =>
      edge.grantee === userId &&
      (edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage')
    if (prefetch?.issueGrantIds.has(issueId)) {
      return (prefetch.issueGrants().get(issueId) ?? []).some(admits)
    }
    return measure('visibility.issue.grants.listForResource', () =>
      store.grants.listForResource('issue', issueId).some(admits),
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
      const row = readSession(asSessionId(sessionId), prefetch)
      if (row?.ownerUserId === userId) return true
      return sessionGrantAdmits(sessionId, userId, prefetch)
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
        if (ref.entity === 'issue' || ref.entity === 'issueProjection') {
          return mayReadIssue(asUserId(userId), asIssueId(ref.entityId), prefetch)
        }
        if (ref.entity === 'issueDep') {
          const dep = parseIssueDepId(ref.entityId)
          return dep !== null && mayReadIssue(asUserId(userId), asIssueId(dep.fromId), prefetch)
        }
        if (ref.entity === 'issueEvent') {
          // THE SUBJECT IS IN THE ID (POD-1772), so this decision needs no read of
          // the event itself — which is what lets a `delete` be scoped after the
          // row is gone, exactly like the tombstone arms below.
          try {
            return mayReadIssue(
              asUserId(userId),
              asIssueId(parseIssueEventRowId(ref.entityId).subject),
              prefetch,
            )
          } catch {
            // An unparseable id is not a row anyone may read.
            return false
          }
        }
        if (ref.entity === 'shipOrder') {
          const issueId = readShipOrderIssueId(ref.entityId, prefetch)
          return issueId !== null && mayReadIssue(asUserId(userId), asIssueId(issueId), prefetch)
        }
        if (ref.entity === 'pendingInteraction') {
          // THE SUBJECT SESSION IS IN THE ID (POD-2020), so this needs no read of
          // the interaction itself — which is what lets a `remove` be scoped after
          // the row is gone, exactly like the `issueEvent` arm above.
          let sessionId: string
          try {
            sessionId = parseInteractionRowId(ref.entityId).sessionId
          } catch {
            // An unparseable id is not a row anyone may read.
            return false
          }
          return maySeeSession(userId, sessionId)
        }
        if (ref.entity === 'session') {
          return maySeeSession(userId, ref.entityId)
        }
        if (ref.entity === 'conversation') {
          // BY QUERY, NEVER BY SCAN (POD-1614). This arm is evaluated once per
          // conversation row of a bootstrap, so a `loadSessions().find(…)` here
          // made the read O(conversation rows x sessions) — 18.9 s of blocked
          // event loop on the live corpus, which is what force-closed the
          // client's 10 s heartbeat mid-bootstrap and made the app take ~60 s
          // and two dropped sockets to become usable.
          const row = readConversationSession(ref.entityId, prefetch)
          if (!row) return false
          if (row.ownerUserId === userId) return true
          return sessionGrantAdmits(row.id, userId, prefetch, 'conversation')
        }
        // THROUGH THE TOMBSTONE, and that is the whole point (POD-1509). A
        // commit writes before it scopes, so when a `remove` reaches this
        // decision the row is already deleted. `get()` would answer `undefined`,
        // the policy would refuse the row as `personal-not-granted`, and the
        // deletion would leave as an empty watermark — certified as delivered
        // and never sent. `ownerOf`/`runOwnerOf` read past the tombstone, which
        // is the only state from which a removal's audience is answerable.
        if (ref.entity === 'automation') {
          return (
            measure('visibility.automation.ownerOf', () =>
              store.automations.ownerOf(ref.entityId),
            ) === userId
          )
        }
        if (ref.entity === 'automationRun') {
          return (
            measure('visibility.automationRun.runOwnerOf', () =>
              store.automations.runOwnerOf(ref.entityId),
            ) === userId
          )
        }
        // per-user-state is decided by keyedUserOf, not mayRead.
        if (ref.entity === 'userLayout') return false
        if (ref.entity === 'userReadPosition') return false
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
   * exactly the resources the indirection introduced, and those refs would fall
   * through to a live point read — correct, but the fall-through is the thing
   * this exists to avoid.
   */
  const prepareOver = (refs: readonly EntityRef[]): VisibilityStatePort => {
    const issueIds = new Set<string>()
    const shipOrderIds = new Set<string>()
    const sessionIds = new Set<string>()
    const resumeValues = new Set<string>()
    for (const ref of refs) {
      if (ref.entity === 'issue' || ref.entity === 'issueProjection') {
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
      }
    }
    const issueIdsByShipOrder =
      shipOrderIds.size === 0
        ? new Map<string, string>()
        : measure('visibility.shipOrder.issueIdForOrder', () =>
            store.shipping.issueIdsForOrders([...shipOrderIds]),
          )
    for (const issueId of issueIdsByShipOrder.values()) issueIds.add(issueId)
    const issues =
      issueIds.size === 0
        ? new Map<string, IssueRow>()
        : measure('visibility.issue.getIssue', () => store.issues.getIssues([...issueIds]))
    const sessions =
      sessionIds.size === 0
        ? new Map<string, SessionRow>()
        : measure('visibility.session.getSession', () =>
            store.sessions.getSessions([...sessionIds]),
          )
    const sessionsByResumeValue =
      resumeValues.size === 0
        ? new Map<string, SessionRow>()
        : measure('visibility.conversation.findSessionByResumeValue', () =>
            store.sessions.findSessionsByResumeValues([...resumeValues]),
          )
    // The session ids a grant question can be asked about: the ones named
    // directly, plus the ones a conversation resolved to.
    const grantedSessionIds = new Set<string>(sessionIds)
    for (const row of sessionsByResumeValue.values()) grantedSessionIds.add(row.id)
    const issueGrants = onFirstAsk(() =>
      issueIds.size === 0
        ? new Map<string, GrantRow[]>()
        : measure('visibility.issue.grants.listForResource', () =>
            store.grants.listForResources('issue', [...issueIds]),
          ),
    )
    const sessionGrants = onFirstAsk(() =>
      grantedSessionIds.size === 0
        ? new Map<string, GrantRow[]>()
        : measure('visibility.session.grants.listForResource', () =>
            store.grants.listForResources('session', [...grantedSessionIds]),
          ),
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
      issueGrantIds: issueIds,
      issueGrants,
      sessionGrantIds: grantedSessionIds,
      sessionGrants,
    })
  }

  let readCache: BootstrapReadCache | undefined
  const currentBootstrapReadCache = (): BootstrapReadCache => {
    const generation = store.sync.latestChangeStatesGeneration()
    if (readCache?.generation === generation) return readCache
    const latestByRef = new Map<string, Map<string, ChangeLogReadRow>>()
    const issueDepsByFromId = new Map<string, IssueDepSubject[]>()
    const shipOrdersByIssueId = new Map<string, ShipOrderSubject[]>()
    for (const row of store.sync.latestChangeStates()) {
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
    readCache = {
      generation,
      latestByRef,
      issueDepsByFromId,
      shipOrdersByIssueId,
    }
    return readCache
  }
  /**
   * The sessions bound to one issue, from the generation's one fill.
   *
   * See {@link BootstrapReadCache.sessionsByIssue}: the fill is sized by the
   * audience map, so the fall-through below is reached only by an issue that
   * gained an audience after the fill — rare, and a point read rather than a
   * refill because refilling would re-read every anchorable issue to learn about
   * one.
   */
  const sessionsForIssue = (cache: BootstrapReadCache, issueId: string): SessionRow[] => {
    let held = cache.sessionsByIssue
    if (held === undefined) {
      const anchorable = store.grants.visibilityAudienceResourceIds('issue')
      const byIssueId = new Map<string, SessionRow[]>()
      const rows =
        anchorable.length === 0
          ? []
          : store.sessions.findSessionsByIssueIds(anchorable.map((id) => asIssueId(id)))
      for (const row of rows) {
        const boundTo = row.issueId
        if (boundTo == null) continue
        const bucket = byIssueId.get(boundTo)
        if (bucket) bucket.push(row)
        else byIssueId.set(boundTo, [row])
      }
      held = { covered: new Set(anchorable), byIssueId }
      cache.sessionsByIssue = held
    }
    const known = held.byIssueId.get(issueId)
    if (known !== undefined) return known
    if (held.covered.has(issueId)) return []
    const rows = store.sessions.findSessionsByIssueIds([asIssueId(issueId)])
    held.covered.add(issueId)
    held.byIssueId.set(issueId, rows)
    return rows
  }

  const durableChangeValueOf = (ref: { entity: string; entityId: string }): unknown => {
    const row = currentBootstrapReadCache().latestByRef.get(ref.entity)?.get(ref.entityId)
    if (row?.op !== 'upsert' || row.payload === null) return undefined
    try {
      return JSON.parse(row.payload)
    } catch {
      return undefined
    }
  }

  const anchors: VisibilityAnchorPort = {
    visibilityEdge: (ref) => {
      if (ref.entity !== 'issue') return null
      const audience = store.grants.visibilityAudienceFor('issue', ref.entityId)
      if (audience.length === 0) return null
      const cache = currentBootstrapReadCache()
      // BY QUERY, NEVER BY SCAN [POD-3261], the same lesson the `conversation`
      // arm learned at POD-1614. See {@link BootstrapReadCache.sessionsByIssue}.
      const issueSessions = sessionsForIssue(cache, ref.entityId)
      const subjects = [
        { entity: 'issue' as const, entityId: ref.entityId },
        { entity: 'issueProjection' as const, entityId: ref.entityId },
        ...issueSessions.map((session) => ({
          entity: 'session' as const,
          entityId: session.id,
        })),
        ...issueSessions.flatMap((session) =>
          session.resumeValue
            ? [
                {
                  entity: 'conversation' as const,
                  entityId: session.resumeValue,
                },
              ]
            : [],
        ),
        ...(cache.issueDepsByFromId.get(ref.entityId) ?? []),
        // The issue's feed history rides its audience (POD-1772): a grant that
        // hands somebody the issue and none of its events would give them a
        // chat pane that starts at the moment they were let in.
        ...(deps.issueEventSubjects?.(asIssueId(ref.entityId)) ?? []),
        ...(cache.shipOrdersByIssueId.get(ref.entityId) ?? []),
      ]
      return { audience, subjects }
    },
    currentValueOf: (ref) => durableChangeValueOf(ref),
  }

  return {
    state: makeVisibilityState(),
    anchors,
    beginBootstrapRead,
    finishBootstrapRead,
    authorizationRevision: () => store.grants.visibilityRevision(),
    mayReadIssue: (userId, issueId) => mayReadIssue(userId, issueId),
  }
}
