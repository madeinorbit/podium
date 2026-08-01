import { asUserId, type SessionId } from '@podium/model'
import type { ApprovalWire } from '@podium/protocol'
import type { DraftEditMessage } from '@podium/protocol'
import { userCommandPrincipal } from '../../command-principal'
import type { BrowserOpenGateway } from '../../gateway/browser-open'
import type { SessionsClientFrame } from '../../gateway/client-frame-routing'
import type { ClientPrincipal } from '../../gateway/client-principal'
import { feedPrincipalOf } from '../../gateway/client-principal'
import type { ClientConn, ClientRegistry } from '../../gateway/client-registry'
import { perfPrincipal } from '../perf/principal'
import { perf } from '../perf/registry'
import type { MachinesService } from '../machines/service'
import type { HostsService } from '../hosts/service'
import type { SessionInbox } from './inbox'
import type { SessionPublicationCoordinator } from './publication/coordinator'
import type { Session } from './session'
import { sessionStatePrincipalFor } from './session-state/registry'
import type { SessionStateService } from './session-state/service'

export interface SessionClientControlPorts {
  clients: ClientRegistry
  sessions: ReadonlyMap<SessionId, Session>
  publication: SessionPublicationCoordinator
  state: SessionStateService
  inbox: SessionInbox
  machines: MachinesService
  hosts: HostsService
  browserOpen: BrowserOpenGateway
  approvalsPending(): ApprovalWire[]
  mutate(
    sessionId: SessionId,
    change: (session: Session) => void,
    issueRelevant?: boolean,
  ): void
  broadcastSessions(): void
  pushPriorities(): void
  disconnectClient?(id: string): void
  setDraft(principal: ClientPrincipal, clientId: string, sessionId: SessionId, text: string): void
  editDraft(message: DraftEditMessage, clientId: string): void
}

/** Client control-plane adapter; transport framing remains in gateway/client-mux. */
export class SessionClientControl {
  constructor(private readonly ports: SessionClientControlPorts) {}

  onAttached(_principal: ClientPrincipal, client: ClientConn): void {
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
      client.send({ type: 'machinesChanged', machines: this.ports.machines.listMachines() })
      client.send({ type: 'approvalsChanged', pending: this.ports.approvalsPending() })
      this.ports.hosts.snapshotFor(client.send)
    }
    this.ports.browserOpen.replayPending(client)
  }

  onDetached(_principal: ClientPrincipal, client: ClientConn): void {
    for (const sessionId of client.attached) {
      this.ports.mutate(
        sessionId,
        (session) => session.terminal.detachClient(client.id),
        false,
      )
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
        if (message.clientId && message.clientId !== id) {
          this.reclaim(message.clientId, client)
        }
        break
      case 'attach': {
        const startedAt = performance.now()
        const session = this.ports.sessions.get(message.sessionId)
        if (!session) return
        client.attached.add(message.sessionId)
        this.ports.mutate(
          message.sessionId,
          (current) => current.terminal.attachClient(client, message.sinceSeq),
          false,
        )
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
        this.ports.mutate(
          message.sessionId,
          (session) => session.terminal.detachClient(id),
          false,
        )
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
        this.ports.inbox.handleControllerInput(
          principal,
          client,
          message.sessionId,
          message.data,
        )
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
      case 'presence':
        client.visible = message.visible
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

  private reclaim(priorId: string, next: ClientConn): void {
    const prior = this.ports.clients.get(priorId)
    if (!prior || prior.id === next.id) return
    for (const sessionId of prior.attached) {
      this.ports.sessions.get(sessionId)?.terminal.reassignController(priorId, next.id)
    }
    if (this.ports.disconnectClient) this.ports.disconnectClient(priorId)
    else if (this.ports.clients.delete(priorId)) this.onDetached(prior.principal, prior)
  }
}
