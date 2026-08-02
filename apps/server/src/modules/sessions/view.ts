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
    return [...this.ports.sessions.values()]
      .filter((session) => this.ports.state.canReadSession(principal, session.sessionId))
      .map((session) => this.wire(session, principal))
  }

  wire(session: Session, forPrincipal?: SessionStatePrincipal): SessionMeta {
    const harnessCapabilities = harnessCapabilitiesFor(session.agentKind)
    const viewer = forPrincipal ?? this.defaultPrincipal()
    const meta = session.toMeta(
      viewer ? this.ports.state.overlay(viewer.userId, session.sessionId) : NO_SESSION_USER_STATE,
    )
    const occupancy = this.ports.sessionOccupancyCount?.(session.sessionId)
    return this.stampRef(session, {
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

  private stampRef(session: Session, meta: SessionMeta): SessionMeta {
    const displayRef = this.computeDisplayRef(session)
    return {
      ...meta,
      ...(session.refIssueId ? { refIssueId: session.refIssueId } : {}),
      ...(session.refLetter ? { refLetter: session.refLetter } : {}),
      ...(session.refDraft != null ? { refDraft: session.refDraft } : {}),
      ...(displayRef ? { displayRef } : {}),
    }
  }

  private computeDisplayRef(session: Session): string | undefined {
    if (session.refIssueId && session.refLetter) {
      const issue = this.ports.store.issues.getIssue(session.refIssueId)
      if (!issue) return undefined
      const prefix = this.ports.store.repos.prefixForPath(issue.repoPath)
      return prefix
        ? formatSessionRef({ prefix, seq: issue.seq, letter: session.refLetter })
        : undefined
    }
    if (session.refDraft != null) {
      const prefix = this.ports.store.repos.prefixForPath(session.cwd)
      return prefix ? formatSessionRef({ prefix, draft: session.refDraft }) : undefined
    }
    return undefined
  }
}
