import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

function setup() {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'm1', name: 'one', hostname: 'one', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'm2', name: 'two', hostname: 'two', tokenHash: 'y' })
  const registry = new SessionRegistry(store)
  registries.push(registry)
  const m1: ControlMessage[] = []
  const m2: ControlMessage[] = []
  registry.modules.sessions.attachDaemon('m1', (message) => m1.push(message))
  registry.modules.sessions.attachDaemon('m2', (message) => m2.push(message))
  const sessionId = registry.modules.sessions.createSession({
    agentKind: 'codex',
    cwd: '/repo',
    machineId: 'm1',
  }).sessionId
  m1.length = 0
  m2.length = 0
  return { registry, sessionId, m1, m2 }
}

function request(sessionId: string, requestId: string) {
  return {
    type: 'sessionOpenUrl' as const,
    sessionId,
    requestId,
    url: 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback',
    callbackTarget: { host: 'localhost' as const, port: 1455, path: '/callback' },
    expiresAt: Date.now() + 60_000,
  }
}

describe('remote browser-open routing', () => {
  it('prefers focused clients, then visible clients, then all clients', () => {
    const { registry, sessionId } = setup()
    const first: ServerMessage[] = []
    const second: ServerMessage[] = []
    const c0 = registry.modules.sessions.attachClient((message) => first.push(message))
    const c1 = registry.modules.sessions.attachClient((message) => second.push(message))
    first.length = 0
    second.length = 0

    registry.modules.sessions.onClientMessage(c0, {
      type: 'viewState',
      visible: [sessionId],
      focused: sessionId,
    })
    registry.modules.sessions.onClientMessage(c1, {
      type: 'viewState',
      visible: [sessionId],
      focused: null,
    })
    registry.modules.sessions.onDaemonMessageFrom('m1', request(sessionId, 'open-focus'))
    expect(first).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-focus' }),
    )
    expect(second).not.toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-focus' }),
    )

    first.length = 0
    second.length = 0
    registry.modules.sessions.onClientMessage(c0, {
      type: 'viewState',
      visible: [],
      focused: null,
    })
    registry.modules.sessions.onDaemonMessageFrom('m1', request(sessionId, 'open-visible'))
    expect(first).not.toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-visible' }),
    )
    expect(second).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-visible' }),
    )

    first.length = 0
    second.length = 0
    registry.modules.sessions.onClientMessage(c1, {
      type: 'viewState',
      visible: [],
      focused: null,
    })
    registry.modules.sessions.onDaemonMessageFrom('m1', request(sessionId, 'open-all'))
    expect(first).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-all' }),
    )
    expect(second).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-all' }),
    )
  })

  it('parks an intent with no client and replays it on the next attach', () => {
    const { registry, sessionId } = setup()
    registry.modules.sessions.onDaemonMessageFrom('m1', request(sessionId, 'open-parked'))

    const messages: ServerMessage[] = []
    registry.modules.sessions.attachClient((message) => messages.push(message))
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'sessionOpenUrl', requestId: 'open-parked' }),
    )
  })

  it('routes callback and dismissal only to the daemon that owns the pending session', () => {
    const { registry, sessionId, m1, m2 } = setup()
    const messages: ServerMessage[] = []
    const clientId = registry.modules.sessions.attachClient((message) => messages.push(message))
    messages.length = 0
    registry.modules.sessions.onDaemonMessageFrom('m1', request(sessionId, 'open-callback'))

    registry.modules.sessions.onClientMessage(clientId, {
      type: 'sessionOpenUrlCallback',
      sessionId,
      requestId: 'open-callback',
      url: 'http://localhost:1455/callback?code=x',
    })
    expect(m1).toContainEqual({
      type: 'sessionOpenUrlCallback',
      sessionId,
      requestId: 'open-callback',
      url: 'http://localhost:1455/callback?code=x',
    })
    expect(m2).toHaveLength(0)

    registry.modules.sessions.onClientMessage(clientId, {
      type: 'sessionOpenUrlDismiss',
      sessionId,
      requestId: 'open-callback',
    })
    expect(m1).toContainEqual({
      type: 'sessionOpenUrlDismiss',
      sessionId,
      requestId: 'open-callback',
    })
    expect(messages).toContainEqual({
      type: 'sessionOpenUrlResult',
      sessionId,
      requestId: 'open-callback',
      status: 'dismissed',
    })
  })

  it('drops open intents forged by a daemon that does not own the session', () => {
    const { registry, sessionId } = setup()
    const messages: ServerMessage[] = []
    registry.modules.sessions.attachClient((message) => messages.push(message))
    messages.length = 0

    registry.modules.sessions.onDaemonMessageFrom('m2', request(sessionId, 'open-forged'))
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'sessionOpenUrl' }))
  })
})
