import type { Attribution, SessionId, UserId } from '@podium/model'
import { actorSystem, actorUser } from '@podium/model'
import type {
  ClientMessage,
  ControlMessage,
  SessionOpenUrlMessage,
  SessionOpenUrlResultMessage,
} from '@podium/protocol'
import type { ClientConn } from './client-registry'
import { ClientRegistry } from './client-registry'

interface BrowserOpenSession {
  machineId: string
}

interface BrowserOpenOwnership {
  owner: UserId
  grants: string[]
}

export interface BrowserOpenGatewayDeps {
  now(): number
  clients: ClientRegistry
  session(sessionId: SessionId): BrowserOpenSession | undefined
  sessionOwner(sessionId: SessionId): BrowserOpenOwnership | undefined
  toMachine(machineId: string, message: ControlMessage): void
}

/**
 * Gateway/control-plane choreography for remote browser-open requests.
 *
 * This owns transport-principal attribution, visibility-gated client routing,
 * deferred delivery, callback forwarding and expiry. Session lifecycle only
 * supplies the current host lookup; it does not interpret this control flow.
 */
export class BrowserOpenGateway {
  private readonly pending = new Map<string, SessionOpenUrlMessage>()
  private readonly resolvers = new Map<string, Attribution>()
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: BrowserOpenGatewayDeps) {}

  dispose(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer)
    this.expiryTimers.clear()
    this.pending.clear()
    this.resolvers.clear()
  }

  replayPending(client: ClientConn): void {
    for (const request of this.pending.values()) {
      if (this.clientMaySeeSession(client, request.sessionId)) client.send(request)
    }
  }

  onOpenUrl(request: SessionOpenUrlMessage): void {
    if (!this.deps.session(request.sessionId) || request.expiresAt <= this.deps.now()) return
    const requestKey = this.key(request.sessionId, request.requestId)
    if (this.pending.has(requestKey)) return
    this.pending.set(requestKey, request)
    const timer = setTimeout(
      () => this.expire(request.sessionId, request.requestId),
      Math.max(1, request.expiresAt - this.deps.now()),
    )
    timer.unref?.()
    this.expiryTimers.set(requestKey, timer)

    const clients = this.recipients(request.sessionId)
    const focused = clients.filter((client) => client.focused === request.sessionId)
    const visible = clients.filter((client) => client.viewVisible.has(request.sessionId))
    const recipients = focused.length > 0 ? focused : visible.length > 0 ? visible : clients
    for (const client of recipients) this.deps.clients.deliver(client, request)
  }

  onOpenUrlResult(machineId: string, message: SessionOpenUrlResultMessage): void {
    const session = this.deps.session(message.sessionId)
    if (!session || session.machineId !== machineId) return
    const requestKey = this.key(message.sessionId, message.requestId)
    if (!this.pending.has(requestKey)) return
    // The daemon is authenticated as a machine, not as the human who resolved
    // this login. Preserve the actor stamped at the browser command boundary.
    const resolvedBy = this.resolvers.get(requestKey)
    const { resolvedBy: _ignoredPayloadIdentity, ...result } = message
    if (message.status !== 'failed') this.clear(message.sessionId, message.requestId)
    this.deliverResult({ ...result, ...(resolvedBy ? { resolvedBy } : {}) })
  }

  submitCallback(
    client: ClientConn,
    message: Extract<ClientMessage, { type: 'sessionOpenUrlCallback' }>,
  ): void {
    const requestKey = this.key(message.sessionId, message.requestId)
    const request = this.pending.get(requestKey)
    const session = this.deps.session(message.sessionId)
    const resolvedBy = this.resolutionActor(client)
    if (
      !request ||
      !session ||
      request.expiresAt <= this.deps.now() ||
      !this.clientMaySeeSession(client, message.sessionId)
    ) {
      this.deps.clients.deliver(client, {
        type: 'sessionOpenUrlResult',
        sessionId: message.sessionId,
        requestId: message.requestId,
        status: 'expired',
        resolvedBy,
      })
      return
    }
    this.resolvers.set(requestKey, resolvedBy)
    this.deps.toMachine(session.machineId, {
      type: 'sessionOpenUrlCallback',
      sessionId: message.sessionId,
      requestId: message.requestId,
      url: message.url,
      resolvedBy,
    })
  }

  dismiss(
    client: ClientConn,
    message: Extract<ClientMessage, { type: 'sessionOpenUrlDismiss' }>,
  ): void {
    const requestKey = this.key(message.sessionId, message.requestId)
    if (!this.pending.has(requestKey) || !this.clientMaySeeSession(client, message.sessionId))
      return
    const session = this.deps.session(message.sessionId)
    const resolvedBy = this.resolutionActor(client)
    this.clear(message.sessionId, message.requestId)
    if (session) {
      this.deps.toMachine(session.machineId, {
        type: 'sessionOpenUrlDismiss',
        sessionId: message.sessionId,
        requestId: message.requestId,
        resolvedBy,
      })
    }
    this.deliverResult({
      type: 'sessionOpenUrlResult',
      sessionId: message.sessionId,
      requestId: message.requestId,
      status: 'dismissed',
      resolvedBy,
    })
  }

  private key(sessionId: SessionId, requestId: string): string {
    return `${sessionId}:${requestId}`
  }

  private clear(sessionId: SessionId, requestId: string): void {
    const requestKey = this.key(sessionId, requestId)
    this.pending.delete(requestKey)
    this.resolvers.delete(requestKey)
    const timer = this.expiryTimers.get(requestKey)
    if (timer) clearTimeout(timer)
    this.expiryTimers.delete(requestKey)
  }

  private expire(sessionId: SessionId, requestId: string): void {
    const requestKey = this.key(sessionId, requestId)
    if (!this.pending.has(requestKey)) return
    this.clear(sessionId, requestId)
    const session = this.deps.session(sessionId)
    const resolvedBy: Attribution = {
      actor: actorSystem('browser-open-expiry'),
      onBehalfOf: null,
    }
    if (session) {
      this.deps.toMachine(session.machineId, {
        type: 'sessionOpenUrlDismiss',
        sessionId,
        requestId,
        resolvedBy,
      })
    }
    this.deliverResult({
      type: 'sessionOpenUrlResult',
      sessionId,
      requestId,
      status: 'expired',
      resolvedBy,
    })
  }

  private clientMaySeeSession(client: ClientConn, sessionId: SessionId): boolean {
    const authority = client.publication
    if (authority) {
      return authority.global || authority.snapshot().allowedSessionIds.includes(sessionId)
    }
    const ownership = this.deps.sessionOwner(sessionId)
    if (!ownership) return false
    return (
      ownership.owner === client.principal.user || ownership.grants.includes(client.principal.user)
    )
  }

  private recipients(sessionId: SessionId): ClientConn[] {
    return [...this.deps.clients.values()].filter((client) =>
      this.clientMaySeeSession(client, sessionId),
    )
  }

  private deliverResult(message: SessionOpenUrlResultMessage): void {
    for (const client of this.recipients(message.sessionId)) {
      this.deps.clients.deliver(client, message)
    }
  }

  private resolutionActor(client: ClientConn): Attribution {
    return { actor: actorUser(client.principal.user), onBehalfOf: client.principal.user }
  }
}
