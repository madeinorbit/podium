import {
  FIRST_ADMIN_USER_ID,
  NO_SESSION_USER_STATE,
  type SessionId,
  type SessionMeta,
  type SessionUserOverlay,
  type UserId,
} from '@podium/model'
import { formatSessionRef } from '@podium/protocol'
import { userCommandPrincipal } from '../../command-principal'
import { harnessCapabilitiesFor } from '../../harness-manifest'
import { isIssueMember } from '../../issue-util'
import type { SessionStore } from '../../store'
import type { MachinesService } from '../machines/service'
import { DEPLOYMENT, perf } from '../perf/registry'
import type { Session } from './session'
import { sessionStatePrincipalFor } from './session-state/registry'
import type { SessionStatePrincipal, SessionStateService } from './session-state/service'

/**
 * Read-through memo for ONE full-list pass [POD-1618].
 *
 * Building the reader-scoped list asks the same few questions once per session:
 * the visibility check resolves the session's owning issue and that resource's
 * grant edges, and `computeDisplayRef` resolves the ref issue and its repo
 * prefix. Those keys are shared HEAVILY — every session attached to one issue
 * repeats that issue's row and grant query, and every session under one repo
 * repeats that repo's prefix — so a 1119-session list ran ~5 queries per
 * session where a few dozen distinct answers exist.
 *
 * Lifetime is exactly one `list()` call, which is why this is a plain object
 * passed down rather than a field: nothing can observe a stale entry, because
 * nothing outside the pass holds one. The SET of sessions returned and every
 * field on them is unchanged — the same answers, asked fewer times.
 */
export interface SessionListMemo {
  /** Issue rows by id (null = looked up and absent). */
  issues: Map<string, unknown>
  /** Grantee lists by `${resourceKind}:${resourceId}`. */
  grants: Map<string, string[]>
  /** Repo prefix by path (null = looked up and absent). */
  prefixes: Map<string, string | null>
}

export const newSessionListMemo = (): SessionListMemo => ({
  issues: new Map(),
  grants: new Map(),
  prefixes: new Map(),
})

export interface SessionViewPorts {
  sessions: Map<SessionId, Session>
  store: SessionStore
  machines: MachinesService
  state: SessionStateService
  /**
   * Room occupancy for a session (POD-1081). When provided, `clientCount` is
   * the occupancy size rather than the PTY attach-set size — attach remains for
   * frame delivery; who-is-watching is presence rooms.
   */
  sessionOccupancyCount?(sessionId: SessionId): number | undefined
}

/** The single live-model → reader-scoped SessionMeta projection. */
export class SessionView {
  constructor(private readonly ports: SessionViewPorts) {}

  list(forPrincipal?: SessionStatePrincipal): SessionMeta[] {
    const startedAt = performance.now()
    try {
      return this.project([...this.ports.sessions.values()], forPrincipal)
    } finally {
      perf.record('phase', 'sessionView.list', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /**
   * The SESSIONS OF ONE ISSUE, without building the other 1100 [POD-1639].
   *
   * `sessionsForIssue(path, list(), id)` is the shape almost every issue mutation
   * wanted: a handful of member sessions. It got them by building the full
   * reader-scoped projection and discarding it — measured on the live corpus
   * (1582 issues / 1119 visible sessions), `cascadeArchiveSessions` found ZERO
   * members and still paid the whole pass, twice per archive.
   *
   * The narrowing is legitimate because membership is decided by two fields that
   * live on the session itself — `issueId` and `cwd` — and the projection copies
   * both through unchanged. So {@link isIssueMember} against the live objects
   * selects the same set the post-filter would, and only that set is visibility-
   * checked and wired. Visibility is NOT narrowed: the surviving members still go
   * through `canReadSession` for the same principal, so a caller sees exactly the
   * sessions it saw before.
   */
  listForIssue(
    worktreePath: string | null,
    issueId: string | undefined,
    forPrincipal?: SessionStatePrincipal,
  ): SessionMeta[] {
    const startedAt = performance.now()
    try {
      const members = [...this.ports.sessions.values()].filter((session) =>
        isIssueMember(worktreePath, issueId, session),
      )
      return this.project(members, forPrincipal)
    } finally {
      perf.record('phase', 'sessionView.listForIssue', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /**
   * ONE SESSION BY ID, without building the other 1100 [POD-1646].
   *
   * `list().find((s) => s.sessionId === id)` was spelled at 36 sites, several of
   * them on the authorization path — so a by-id lookup paid a full reader-scoped
   * pass on essentially every request. The narrowing is sound for the same
   * reason `listForIssue`'s is: the deciding field is the session's OWN id, and
   * `ports.sessions` is the very map `list()` enumerates, keyed by `sessionId`
   * at every writer. Visibility is NOT narrowed — the one candidate still goes
   * through `canReadSession` for the same principal, so a caller sees `undefined`
   * in exactly the cases the post-filter left it empty.
   */
  byId(sessionId: SessionId, forPrincipal?: SessionStatePrincipal): SessionMeta | undefined {
    const startedAt = performance.now()
    try {
      const session = this.ports.sessions.get(sessionId)
      if (!session) return undefined
      return this.project([session], forPrincipal)[0]
    } finally {
      perf.record('phase', 'sessionView.byId', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /**
   * `byId(id)?.spawnedBy` WITHOUT THE WIRE [POD-1646].
   *
   * The authz sites (layout, fleet, settings, read-position) and the delegation
   * index want one string, not a `SessionMeta`. Wiring one costs the harness
   * manifest, the user overlay, the machine name and the display-ref resolution
   * — every one of them discarded here. `spawnedBy` is a plain field that
   * `toMeta` copies through unchanged (falsy stripped, which is the same
   * `undefined` optional chaining produced), so this returns what the wired
   * lookup returned, under the same visibility check.
   */
  spawnedByOf(sessionId: SessionId, forPrincipal?: SessionStatePrincipal): string | undefined {
    const startedAt = performance.now()
    try {
      const session = this.ports.sessions.get(sessionId)
      if (!session) return undefined
      const principal = forPrincipal ?? this.defaultPrincipal()
      if (!principal) return undefined
      if (!this.ports.state.canReadSession(principal, sessionId, newSessionListMemo())) {
        return undefined
      }
      return session.spawnedBy
    } finally {
      perf.record('phase', 'sessionView.spawnedByOf', performance.now() - startedAt, DEPLOYMENT)
    }
  }

  /** The reader-scoped projection over a candidate set — the body `list()`,
   *  `listForIssue()` and `byId()` share so the visibility rule and the memo
   *  lifetime have exactly one definition. */
  private project(candidates: Session[], forPrincipal?: SessionStatePrincipal): SessionMeta[] {
    const principal = forPrincipal ?? this.defaultPrincipal()
    if (!principal) return []
    // ONE memo for the whole pass [POD-1618] — see {@link SessionListMemo}.
    const memo = newSessionListMemo()
    // ...and fill its grant half up front [POD-1653]. Sessions with no issue key
    // their grants on their own id, so the memo alone can never coalesce them:
    // ~1145 distinct keys per pass, each its own zero-row statement. Primed, the
    // whole pass costs two reads. Same rows, same freshness — see
    // `GrantsRepository.listForResources` on why this is batching, not caching.
    this.ports.state.primeOwnerMemo?.(
      memo,
      candidates.map((session) => session.sessionId),
    )
    return candidates
      .filter((session) => this.ports.state.canReadSession(principal, session.sessionId, memo))
      .map((session) => this.wire(session, principal, memo))
  }

  wire(
    session: Session,
    forPrincipal?: SessionStatePrincipal,
    memo?: SessionListMemo,
  ): SessionMeta {
    const harnessCapabilities = harnessCapabilitiesFor(session.agentKind)
    const viewer = forPrincipal ?? this.defaultPrincipal()
    const loginCondition = this.ports.machines.agentLoginCondition?.(
      session.machineId,
      session.agentKind,
    )
    const meta = session.toMeta(
      viewer ? this.ports.state.overlay(viewer.userId, session.sessionId) : NO_SESSION_USER_STATE,
    )
    const occupancy = this.ports.sessionOccupancyCount?.(session.sessionId)
    return this.stampRef(session, memo, {
      ...meta,
      // Presence-room occupancy is the product "who is watching" count when the
      // stream plane is wired; attach-set size remains the fallback for fixtures.
      ...(occupancy !== undefined ? { clientCount: occupancy } : {}),
      machineName: this.ports.machines.machineName(session.machineId),
      ...(loginCondition ? { condition: loginCondition } : {}),
      ...(harnessCapabilities
        ? {
            harnessHandoff: harnessCapabilities.handoff,
            harnessPromptModeHints: harnessCapabilities.promptModeHints,
          }
        : {}),
    })
  }

  broadcastViewer(): UserId {
    return FIRST_ADMIN_USER_ID
  }

  principalForTrustedUser(userId: UserId): SessionStatePrincipal {
    const role = this.ports.store.users.roleOf(userId)
    if (!role) throw new Error(`refused: no active account for session-state user ${userId}`)
    return sessionStatePrincipalFor(userCommandPrincipal(userId, role))
  }

  defaultPrincipal(): SessionStatePrincipal | undefined {
    const role = this.ports.store.users.roleOf(FIRST_ADMIN_USER_ID)
    return role
      ? sessionStatePrincipalFor(userCommandPrincipal(FIRST_ADMIN_USER_ID, role))
      : undefined
  }

  overlay(sessionId: SessionId): SessionUserOverlay {
    return this.ports.state.overlay(this.broadcastViewer(), sessionId)
  }

  prepareRefAllocation(session: Session): (() => void) | undefined {
    if (session.refIssueId || session.refDraft != null) return
    const birthIssueId = session.issueId ?? null
    if (birthIssueId) {
      const issue = this.ports.store.issues.getIssue(birthIssueId)
      if (issue) {
        return () => {
          session.refLetter = this.ports.store.issues.allocateSessionLetter(birthIssueId)
          session.refIssueId = birthIssueId
        }
      }
    }
    const repoId = this.ports.store.repos.resolveRepoIdForPath(session.cwd)
    if (this.ports.store.repos.prefixForRepoId(repoId) === null) return
    return () => {
      session.refDraft = this.ports.store.repos.nextDraftSeq(repoId)
    }
  }

  private stampRef(
    session: Session,
    memo: SessionListMemo | undefined,
    meta: SessionMeta,
  ): SessionMeta {
    const displayRef = this.computeDisplayRef(session, memo)
    return {
      ...meta,
      ...(session.refIssueId ? { refIssueId: session.refIssueId } : {}),
      ...(session.refLetter ? { refLetter: session.refLetter } : {}),
      ...(session.refDraft != null ? { refDraft: session.refDraft } : {}),
      ...(displayRef ? { displayRef } : {}),
    }
  }

  private computeDisplayRef(session: Session, memo?: SessionListMemo): string | undefined {
    if (session.refIssueId && session.refLetter) {
      const issue = this.memoIssue(session.refIssueId, memo)
      if (!issue) return undefined
      const prefix = this.memoPrefix(issue.repoPath, memo)
      return prefix
        ? formatSessionRef({ prefix, seq: issue.seq, letter: session.refLetter })
        : undefined
    }
    if (session.refDraft != null) {
      const prefix = this.memoPrefix(session.cwd, memo)
      return prefix ? formatSessionRef({ prefix, draft: session.refDraft }) : undefined
    }
    return undefined
  }

  /** Same lookup, memoized for the pass — see {@link SessionListMemo}. */
  private memoIssue(id: string, memo?: SessionListMemo): { repoPath: string; seq: number } | null {
    if (!memo) return this.ports.store.issues.getIssue(id) as never
    if (!memo.issues.has(id)) memo.issues.set(id, this.ports.store.issues.getIssue(id))
    return memo.issues.get(id) as never
  }

  private memoPrefix(path: string, memo?: SessionListMemo): string | null {
    if (!memo) return this.ports.store.repos.prefixForPath(path) ?? null
    const hit = memo.prefixes.get(path)
    if (hit !== undefined) return hit
    const value = this.ports.store.repos.prefixForPath(path) ?? null
    memo.prefixes.set(path, value)
    return value
  }
}
