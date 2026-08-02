import { asUserId, type SessionId, type UserId } from '@podium/model'
import type { DraftEditMessage } from '@podium/protocol'
import { userCommandPrincipal } from '../../command-principal'
import type { BrowserOpenGateway } from '../../gateway/browser-open'
import type { SessionsClientFrame } from '../../gateway/client-frame-routing'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { feedPrincipalOf } from '../../gateway/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import { perfPrincipal } from '../perf/principal'
import { perf } from '../perf/registry'
import type { MachineListing } from '../machines/service'
import type { SessionInbox } from './inbox'
import type { SessionPublicationCoordinator } from './publication/coordinator'
import type { Session } from './session'
import {
  contextFromOwnership,
  controlSubjectFromClient,
  mayDrive,
  mayWatch,
  type SessionControlContext,
} from './session-control-policy'
import { sessionStatePrincipalFor } from './session-state/registry'
import type { SessionStateService } from './session-state/service'

export interface SessionClientControlPorts {
  sessions: ReadonlyMap<SessionId, Session>
  publication: SessionPublicationCoordinator
  state: SessionStateService
  inbox: SessionInbox
  machinesForPrincipal(principal: ClientPrincipal): MachineListing[]
  browserOpen: BrowserOpenGateway
  mutate(sessionId: SessionId, change: (session: Session) => void, issueRelevant?: boolean): void
  broadcastSessions(): void
  pushPriorities(): void
  setDraft(principal: ClientPrincipal, clientId: string, sessionId: SessionId, text: string): void
  editDraft(message: DraftEditMessage, clientId: string): void
  /**
   * Session ownership + grants (from store). Undefined ⇒ session does not exist
   * (or is invisible — same answer per the consistent-error rule).
   */
  sessionOwner?(sessionId: SessionId): { owner: UserId; grants: string[] } | undefined
  /**
   * Machine `use` for this principal on the session's host. Defaults to
   * `granted` when uninjected so unit fixtures without a machine table keep
   * working; production always wires the real gate.
   */
  machineUseFor?(
    principal: ClientPrincipal,
    sessionId: SessionId,
  ): SessionControlContext['machineUse']
  /**
   * Room occupancy count for a session (presence plane). When provided,
   * `clientCount` is derived from it rather than from the attach-set size.
   */
  sessionOccupancyCount?(sessionId: SessionId): number | undefined
  /** Join/leave session presence room with PTY attach (POD-1081 §5). */
  sessionRoomJoin?(client: ClientConn, sessionId: SessionId): void
  sessionRoomLeave?(client: ClientConn, sessionId: SessionId): void
}

/** Client control-plane adapter; transport framing remains in gateway/client-mux. */
export class SessionClientControl {
  constructor(private readonly ports: SessionClientControlPorts) {}

  onAttached(principal: ClientPrincipal, client: ClientConn): void {
    const publication = client.publication
    if (publication) this.ports.publication.schedule()
    if (!publication || publication.global) {
      this.ports.state.replayDrafts(
        sessionStatePrincipalFor(
          userCommandPrincipal(asUserId(client.principal.user), client.principal.role),
          client.id,
        ),
        client.send,
      )
      client.send({
        type: 'machinesChanged',
        machines: this.ports.machinesForPrincipal(principal),
      })
    }
  }

  onDetached(_principal: ClientPrincipal, client: ClientConn): void {
    for (const sessionId of client.attached) {
      this.ports.mutate(sessionId, (session) => session.terminal.detachClient(client.id), false)
      this.ports.sessionRoomLeave?.(client, sessionId)
    }
    for (const sessionId of client.transcriptSubs) {
      this.ports.sessions.get(sessionId)?.terminal.unsubscribeTranscript(client.id)
    }
    this.ports.pushPriorities()
    this.ports.broadcastSessions()
  }

  onFrame(principal: ClientPrincipal, client: ClientConn, message: SessionsClientFrame): void {
    const id = client.id
    switch (message.type) {
      case 'hello':
        if (message.caps) client.caps = new Set(message.caps)
        if (client.publication && !client.publicationBootstrapped) {
          this.ports.publication.schedule()
        }
        break
      case 'attach': {
        const startedAt = performance.now()
        const session = this.ports.sessions.get(message.sessionId)
        // Visibility + machine use both gate attach (POD-1081 §4). Absent session
        // and denied rights share the same unauthorized outcome — no existence
        // oracle (ADR 3 Amendment 1 D20).
        const allowed = this.authorizeAttach(principal, message.sessionId, session)
        if (!allowed || !session) {
          client.send({
            type: 'terminalOutcome',
            sessionId: message.sessionId,
            outcome: 'unauthorized',
          })
          break
        }
        client.attached.add(message.sessionId)
        this.ports.mutate(
          message.sessionId,
          (current) => current.terminal.attachClient(client, message.sinceSeq),
          false,
        )
        // Watching a terminal is room membership — clientCount derives from it.
        this.ports.sessionRoomJoin?.(client, message.sessionId)
        this.ports.broadcastSessions()
        this.ports.pushPriorities()
        perf.record(
          'phase',
          'ws.attach',
          performance.now() - startedAt,
          perfPrincipal(feedPrincipalOf(client.principal)),
        )
        break
      }
      case 'detach': {
        const startedAt = performance.now()
        client.attached.delete(message.sessionId)
        this.ports.mutate(message.sessionId, (session) => session.terminal.detachClient(id), false)
        this.ports.sessionRoomLeave?.(client, message.sessionId)
        this.ports.broadcastSessions()
        this.ports.pushPriorities()
        perf.record(
          'phase',
          'ws.detach',
          performance.now() - startedAt,
          perfPrincipal(feedPrincipalOf(client.principal)),
        )
        break
      }
      case 'input':
        this.ports.inbox.handleControllerInput(principal, client, message.sessionId, message.data)
        break
      case 'resize':
        this.ports.mutate(message.sessionId, () =>
          this.ports.inbox.handleResize(
            principal,
            client,
            message.sessionId,
            message.cols,
            message.rows,
          ),
        )
        break
      case 'requestControl':
        this.ports.mutate(
          message.sessionId,
          () => this.ports.inbox.requestControl(principal, client, message.sessionId),
          false,
        )
        this.ports.broadcastSessions()
        break
      case 'redrawRequest':
        this.ports.sessions.get(message.sessionId)?.terminal.redraw()
        break
      case 'transcriptSubscribe':
        client.transcriptSubs.add(message.sessionId)
        this.ports.sessions
          .get(message.sessionId)
          ?.terminal.subscribeTranscript(client, message.since)
        break
      case 'transcriptUnsubscribe':
        client.transcriptSubs.delete(message.sessionId)
        this.ports.sessions.get(message.sessionId)?.terminal.unsubscribeTranscript(id)
        break
      case 'viewState':
        client.viewVisible = new Set(message.visible)
        client.focused = message.focused
        client.viewModes = message.modes ?? {}
        for (const sessionId of client.viewVisible) {
          this.ports.mutate(sessionId, () =>
            this.ports.inbox.reconcileGeometry(principal, client, sessionId),
          )
        }
        this.ports.pushPriorities()
        this.ports.publication.prioritize()
        break
      case 'setSessionDraft':
        this.ports.setDraft(principal, id, message.sessionId, message.text)
        break
      case 'draftEdit':
        this.ports.editDraft(message, id)
        break
      case 'sessionOpenUrlCallback':
        this.ports.browserOpen.submitCallback(client, message)
        break
      case 'sessionOpenUrlDismiss':
        this.ports.browserOpen.dismiss(client, message)
        break
    }
  }

  reclaim(prior: ClientConn, next: ClientConn): void {
    for (const sessionId of prior.attached) {
      this.ports.sessions.get(sessionId)?.terminal.reassignController(prior.id, next.id)
    }
  }

  /**
   * Attach requires session visibility AND machine `use`. Session share alone
   * must not open a PTY on a machine the principal cannot use.
   */
  private authorizeAttach(
    principal: ClientPrincipal,
    sessionId: SessionId,
    session: Session | undefined,
  ): boolean {
    if (!session) return false
    const owner = this.ports.sessionOwner?.(sessionId)
    // No ownership port (legacy unit fixtures): keep today's open attach so
    // incident tests stay focused on controller gating rather than multi-user
    // policy. Production always injects sessionOwner.
    if (!this.ports.sessionOwner) return true
    if (!owner) return false
    const machineUse = this.ports.machineUseFor?.(principal, sessionId) ?? 'granted'
    const ctx = contextFromOwnership(owner, machineUse)
    return mayWatch(controlSubjectFromClient(principal), ctx) === true
  }

  /** Drive rights for requestControl — owner / write grantee / admin + machine use. */
  authorizeDrive(principal: ClientPrincipal, sessionId: SessionId): boolean {
    const owner = this.ports.sessionOwner?.(sessionId)
    if (!this.ports.sessionOwner) return true
    if (!owner) return false
    const machineUse = this.ports.machineUseFor?.(principal, sessionId) ?? 'granted'
    const ctx = contextFromOwnership(owner, machineUse)
    return mayDrive(controlSubjectFromClient(principal), ctx) === true
  }
}
