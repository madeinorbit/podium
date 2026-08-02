import {
  type Attribution,
  actorUser,
  asUserId,
  FIRST_ADMIN_USER_ID,
  type SessionId,
} from '@podium/model'
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientPublicationAuthority } from './modules/sessions/session'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'
import { attachTestClient } from './test-support/client-transport'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

function setup() {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({
    id: 'm1',
    name: 'one',
    hostname: 'one',
    tokenHash: 'x',
    ownerUserId: 'user:sole',
  })
  store.machines.upsertMachine({
    id: 'm2',
    name: 'two',
    hostname: 'two',
    tokenHash: 'y',
    ownerUserId: 'user:sole',
  })
  const inventory = JSON.stringify({
    os: 'linux',
    arch: 'x64',
    agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }],
    tools: [],
  })
  store.machines.setMachineInventory('m1', inventory)
  store.machines.setMachineInventory('m2', inventory)
  const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
  registries.push(registry)
  const m1: ControlMessage[] = []
  const m2: ControlMessage[] = []
  registry.gateway.attachDaemon('m1', (message) => m1.push(message))
  registry.gateway.attachDaemon('m2', (message) => m2.push(message))
  const sessionId = registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: '/repo',
    machineId: 'm1',
  }).sessionId
  m1.length = 0
  m2.length = 0
  return { registry, store, sessionId, m1, m2 }
}

function request(sessionId: SessionId, requestId: string) {
  return {
    type: 'sessionOpenUrl' as const,
    sessionId,
    requestId,
    url: 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback',
    callbackTarget: { host: 'localhost' as const, port: 1455, path: '/callback' },
    expiresAt: Date.now() + 60_000,
  }
}

function scopedAuthority(
  principal: string,
  allowedSessionIds: SessionId[],
): ClientPublicationAuthority {
  return {
    principal,
    scope: 'personal',
    serverRole: 'standalone',
    protocolVersion: 1,
    global: false,
    snapshot: () => ({
      revision: 1,
      allowedSignature: JSON.stringify(allowedSessionIds),
      allowedSessionIds,
    }),
    sendPrepared: () => {},
  }
}

const RESOLVER = {
  actor: actorUser(FIRST_ADMIN_USER_ID),
  onBehalfOf: FIRST_ADMIN_USER_ID,
} satisfies Attribution
const SPOOFED_RESOLVER = {
  actor: actorUser(asUserId('user:attacker')),
  onBehalfOf: asUserId('user:attacker'),
} satisfies Attribution

describe('remote browser-open routing', () => {
  it('routes the open/result family only through session-room subscriptions', () => {
    const { registry, sessionId } = setup()
    const first: ServerMessage[] = []
    const second: ServerMessage[] = []
    const c0 = attachTestClient(registry.clientGateway, (message) => first.push(message))
    const c1 = attachTestClient(registry.clientGateway, (message) => second.push(message))
    first.length = 0
    second.length = 0

    registry.gateway.routeDaemonFrame('m1', request(sessionId, 'open-parked'))
    expect(first).not.toContainEqual(expect.objectContaining({ type: 'sessionOpenUrl' }))
    expect(second).not.toContainEqual(expect.objectContaining({ type: 'sessionOpenUrl' }))

    registry.clientGateway.routeClientFrame(c0, {
      type: 'presenceSubscribe',
      room: { kind: 'session', id: sessionId },
    })
    expect(first).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-parked' }),
    )
    expect(second).not.toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-parked' }),
    )

    registry.clientGateway.routeClientFrame(c1, {
      type: 'presenceSubscribe',
      room: { kind: 'session', id: sessionId },
    })
    first.length = 0
    second.length = 0
    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionOpenUrlResult',
      sessionId,
      requestId: 'open-parked',
      status: 'failed',
    })
    expect(first).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrlResult', requestId: 'open-parked' }),
    )
    expect(second).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrlResult', requestId: 'open-parked' }),
    )

    registry.clientGateway.routeClientFrame(c0, {
      type: 'presenceUnsubscribe',
      room: { kind: 'session', id: sessionId },
    })
    first.length = 0
    second.length = 0
    registry.gateway.routeDaemonFrame('m1', request(sessionId, 'open-room-only'))
    expect(first).not.toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-room-only' }),
    )
    expect(second).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-room-only' }),
    )
  })

  it('delivers only to clients whose scoped world may see the session', () => {
    const { registry, store, sessionId } = setup()
    store.grants.upsert({
      resourceKind: 'session',
      resourceId: sessionId,
      grantee: 'user:grantee',
      verb: 'read',
      owner: FIRST_ADMIN_USER_ID,
      visibility: 'personal',
      createdAt: '2026-08-02T00:00:00.000Z',
      actorKind: 'user',
      actorId: FIRST_ADMIN_USER_ID,
      onBehalfOf: FIRST_ADMIN_USER_ID,
    })
    const owner: ServerMessage[] = []
    const grantee: ServerMessage[] = []
    const unrelated: ServerMessage[] = []
    const ownerId = attachTestClient(
      registry.clientGateway,
      {
        send: (message) => owner.push(message),
        userId: FIRST_ADMIN_USER_ID,
        userRole: 'member',
      },
      scopedAuthority('owner', [sessionId]),
    )
    const granteeId = attachTestClient(
      registry.clientGateway,
      {
        send: (message) => grantee.push(message),
        userId: asUserId('user:grantee'),
        userRole: 'member',
      },
      scopedAuthority('grantee', [sessionId]),
    )
    const unrelatedId = attachTestClient(
      registry.clientGateway,
      {
        send: (message) => unrelated.push(message),
        userId: asUserId('user:unrelated'),
        userRole: 'member',
      },
      scopedAuthority('unrelated', []),
    )
    owner.length = 0
    grantee.length = 0
    unrelated.length = 0

    for (const clientId of [ownerId, granteeId, unrelatedId]) {
      registry.clientGateway.routeClientFrame(clientId, {
        type: 'presenceSubscribe',
        room: { kind: 'session', id: sessionId },
      })
    }
    owner.length = 0
    grantee.length = 0
    unrelated.length = 0

    registry.gateway.routeDaemonFrame('m1', request(sessionId, 'open-scoped'))

    expect(owner).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-scoped' }),
    )
    expect(grantee).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-scoped' }),
    )
    expect(unrelated).not.toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-scoped' }),
    )
  })

  it('parks an intent until the next successful session-room join', () => {
    const { registry, sessionId } = setup()
    registry.gateway.routeDaemonFrame('m1', request(sessionId, 'open-parked'))

    const messages: ServerMessage[] = []
    const clientId = attachTestClient(registry.clientGateway, (message) => messages.push(message))
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'sessionOpenUrl' }))

    registry.clientGateway.routeClientFrame(clientId, {
      type: 'presenceSubscribe',
      room: { kind: 'session', id: sessionId },
    })
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-parked' }),
    )
  })

  it('routes to the owning daemon and stamps resolver identity from the transport', () => {
    const { registry, sessionId, m1, m2 } = setup()
    const messages: ServerMessage[] = []
    const clientId = attachTestClient(registry.clientGateway, (message) => messages.push(message))
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'presenceSubscribe',
      room: { kind: 'session', id: sessionId },
    })
    messages.length = 0
    registry.gateway.routeDaemonFrame('m1', request(sessionId, 'open-callback'))

    registry.clientGateway.routeClientFrame(clientId, {
      type: 'sessionOpenUrlCallback',
      sessionId,
      requestId: 'open-callback',
      url: 'http://localhost:1455/callback?code=x',
      resolvedBy: SPOOFED_RESOLVER,
    })
    expect(m1).toContainEqual({
      type: 'sessionOpenUrlCallback',
      sessionId,
      requestId: 'open-callback',
      url: 'http://localhost:1455/callback?code=x',
      resolvedBy: RESOLVER,
    })
    expect(m2).toHaveLength(0)

    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionOpenUrlResult',
      sessionId,
      requestId: 'open-callback',
      status: 'completed',
      resolvedBy: SPOOFED_RESOLVER,
    })
    expect(messages).toContainEqual({
      type: 'sessionOpenUrlResult',
      sessionId,
      requestId: 'open-callback',
      status: 'completed',
      resolvedBy: RESOLVER,
    })

    registry.gateway.routeDaemonFrame('m1', request(sessionId, 'open-dismiss'))
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'sessionOpenUrlDismiss',
      sessionId,
      requestId: 'open-dismiss',
      resolvedBy: SPOOFED_RESOLVER,
    })
    expect(m1).toContainEqual({
      type: 'sessionOpenUrlDismiss',
      sessionId,
      requestId: 'open-dismiss',
      resolvedBy: RESOLVER,
    })
    expect(messages).toContainEqual({
      type: 'sessionOpenUrlResult',
      sessionId,
      requestId: 'open-dismiss',
      status: 'dismissed',
      resolvedBy: RESOLVER,
    })
  })

  it('drops open intents forged by a daemon that does not own the session', () => {
    const { registry, sessionId } = setup()
    const messages: ServerMessage[] = []
    const clientId = attachTestClient(registry.clientGateway, (message) => messages.push(message))
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'presenceSubscribe',
      room: { kind: 'session', id: sessionId },
    })
    messages.length = 0

    registry.gateway.routeDaemonFrame('m2', request(sessionId, 'open-forged'))
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'sessionOpenUrl' }))
  })
})
