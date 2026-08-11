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
  asSessionId,
  parseIssueDepId,
  parseLayoutRowId,
  parseReadPositionRowId,
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
  readonly sessionIds: ReadonlySet<string>
  readonly sessions: ReadonlyMap<string, SessionRow>
  readonly resumeValues: ReadonlySet<string>
  readonly sessionsByResumeValue: ReadonlyMap<string, SessionRow>
}

type IssueDepSubject = {
  entity: 'issueDep'
  entityId: string
}

type BootstrapReadCache = {
  generation: number
  latestByRef: Map<string, Map<string, ChangeLogReadRow>>
  issueDepsByFromId: Map<string, IssueDepSubject[]>
  sessions?: SessionRow[]
}

/** The store surface this policy reads. Nothing here writes. */
export interface FeedVisibilityDeps {
  readonly store: SessionStore
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
  readonly mayReadIssue: (userId: string, issueId: string) => boolean
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

  const readIssue = (issueId: string, prefetch?: BootstrapVisibilityPrefetch): IssueRow | null => {
    if (prefetch?.issueIds.has(issueId)) return prefetch.issues.get(issueId) ?? null
    return measure('visibility.issue.getIssue', () => store.issues.getIssue(issueId))
  }

  const readSession = (
    sessionId: string,
    prefetch?: BootstrapVisibilityPrefetch,
  ): SessionRow | undefined => {
    if (prefetch?.sessionIds.has(sessionId)) return prefetch.sessions.get(sessionId)
    return measure('visibility.session.getSession', () =>
      store.sessions.getSession(asSessionId(sessionId)),
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

  const mayReadIssue = (
    userId: string,
    issueId: string,
    prefetch?: BootstrapVisibilityPrefetch,
  ): boolean => {
    // Authority publishes after the transaction commits but before IssueService
    // installs a newly-created row in its live map. Read the durable row here so
    // the creation frame is scoped from the same committed truth catch-up sees.
    const row = readIssue(issueId, prefetch)
    if (row?.ownerUserId === userId) return true
    return measure('visibility.issue.grants.listForResource', () =>
      store.grants
        .listForResource('issue', issueId)
        .some(
          (edge) =>
            edge.grantee === userId &&
            (edge.verb === 'read' || edge.verb === 'write' || edge.verb === 'manage'),
        ),
    )
  }

  const makeVisibilityState = (prefetch?: BootstrapVisibilityPrefetch): VisibilityStatePort => ({
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
        return mayReadIssue(userId, ref.entityId, prefetch)
      }
      if (ref.entity === 'issueDep') {
        const dep = parseIssueDepId(ref.entityId)
        return dep !== null && mayReadIssue(userId, dep.fromId, prefetch)
      }
      if (ref.entity === 'session') {
        const row = readSession(ref.entityId, prefetch)
        if (row?.ownerUserId === userId) return true
        return measure('visibility.session.grants.listForResource', () =>
          store.grants
            .listForResource('session', ref.entityId)
            .some((edge) => edge.grantee === userId && edge.verb === 'read'),
        )
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
        return measure('visibility.conversation.grants.listForResource', () =>
          store.grants
            .listForResource('session', row.id)
            .some((edge) => edge.grantee === userId && edge.verb === 'read'),
        )
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
    forBootstrap: (refs: readonly EntityRef[]) => {
      const issueIds = new Set<string>()
      const sessionIds = new Set<string>()
      const resumeValues = new Set<string>()
      for (const ref of refs) {
        if (ref.entity === 'issue' || ref.entity === 'issueProjection') {
          issueIds.add(ref.entityId)
        } else if (ref.entity === 'issueDep') {
          const dep = parseIssueDepId(ref.entityId)
          if (dep !== null) issueIds.add(dep.fromId)
        } else if (ref.entity === 'session') {
          sessionIds.add(ref.entityId)
        } else if (ref.entity === 'conversation') {
          resumeValues.add(ref.entityId)
        }
      }
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
      return makeVisibilityState({
        issueIds,
        issues,
        sessionIds,
        sessions,
        resumeValues,
        sessionsByResumeValue,
      })
    },
  })

  let readCache: BootstrapReadCache | undefined
  const currentBootstrapReadCache = (): BootstrapReadCache => {
    const generation = store.sync.latestChangeStatesGeneration()
    if (readCache?.generation === generation) return readCache
    const latestByRef = new Map<string, Map<string, ChangeLogReadRow>>()
    const issueDepsByFromId = new Map<string, IssueDepSubject[]>()
    for (const row of store.sync.latestChangeStates()) {
      const byEntity = latestByRef.get(row.entity) ?? new Map<string, ChangeLogReadRow>()
      byEntity.set(row.entityId, row)
      latestByRef.set(row.entity, byEntity)
      if (row.entity !== 'issueDep' || row.op !== 'upsert') continue
      const dep = parseIssueDepId(row.entityId)
      if (dep === null) continue
      const subjects = issueDepsByFromId.get(dep.fromId) ?? []
      subjects.push({ entity: 'issueDep', entityId: row.entityId })
      issueDepsByFromId.set(dep.fromId, subjects)
    }
    readCache = { generation, latestByRef, issueDepsByFromId }
    return readCache
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
      let sessions = cache.sessions
      if (sessions === undefined) {
        sessions = store.sessions.loadSessions()
        cache.sessions = sessions
      }
      const issueSessions = sessions.filter((session) => session.issueId === ref.entityId)
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
