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
import type { SessionStore } from '../../store'
import type { MachinesService } from '../machines/service'
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
    const principal = forPrincipal ?? this.defaultPrincipal()
    if (!principal) return []
    // ONE memo for the whole pass [POD-1618] — see {@link SessionListMemo}.
    const memo = newSessionListMemo()
    return [...this.ports.sessions.values()]
      .filter((session) => this.ports.state.canReadSession(principal, session.sessionId, memo))
      .map((session) => this.wire(session, principal, memo))
  }

  wire(session: Session, forPrincipal?: SessionStatePrincipal, memo?: SessionListMemo): SessionMeta {
    const harnessCapabilities = harnessCapabilitiesFor(session.agentKind)
    const viewer = forPrincipal ?? this.defaultPrincipal()
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

  private stampRef(session: Session, memo: SessionListMemo | undefined, meta: SessionMeta): SessionMeta {
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
  private memoIssue(
    id: string,
    memo?: SessionListMemo,
  ): { repoPath: string; seq: number } | null {
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
