/**
 * THE SESSION TOPICS ON A REAL SERVER (POD-6764).
 *
 * The decision this proves: the terminal's size is a live reading AND a stored
 * column. With the daemon offline and the server restarted, no process holds
 * the terminal; a client that subscribes to `session.terminalState` must still
 * be told the stored size, so it can show the cached terminal view at the
 * right size. Subscribing reads the row and makes nothing resident.
 */
import { asUserId, type SessionId } from '@podium/model'
import { type ServerMessage, topicKey } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { attachTestClient } from '../../test-support/client-transport'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

async function registryOver(store: SessionStore): Promise<SessionRegistry> {
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(registry)
  return registry
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Subscribe a real client connection to one key; answer the frames it got for it. */
async function subscribe(
  registry: SessionRegistry,
  kind: 'session.terminalState' | 'session.condition',
  sessionId: SessionId,
  peer: { userId?: ReturnType<typeof asUserId>; userRole?: 'admin' | 'member' } = {},
): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = []
  const key = topicKey(kind, sessionId)
  const clientId = attachTestClient(registry.clientGateway, {
    ...peer,
    send: (msg) => {
      if ('key' in msg && msg.key === key) frames.push(msg)
    },
  })
  await registry.clientGateway.routeClientFrame(clientId, { type: 'topicSubscribe', key })
  await settle()
  return frames
}

describe('session topics on a real server (POD-6764)', () => {
  it('serves the STORED terminal size when no process holds the terminal', async () => {
    const store = await openTestStore(':memory:')
    const first = await registryOver(store)
    await attachHostDaemon(first, () => {})
    const { sessionId } = await first.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const host = first.sessionStore.hostMachineId
    await first.gateway.routeDaemonFrame(host, {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/w',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    // The daemon reports the size the pty really has (POD-4771).
    await first.gateway.routeDaemonFrame(host, {
      type: 'geometryApplied',
      sessionId,
      geometry: { cols: 132, rows: 43 },
      cause: 'request',
    })
    await first.modules.sessions.flushBroadcasts()

    // While it runs here, the value is the terminal's.
    const live = await subscribe(first, 'session.terminalState', sessionId)
    expect(live[0]).toMatchObject({
      type: 'topicSnapshot',
      payload: { controller: null, geometry: { cols: 132, rows: 43 } },
    })

    // The size is not on the synced record.
    const record = await first.modules.sessions.sessionById(sessionId)
    expect(record).toBeDefined()
    expect(record).not.toHaveProperty('geometry')
    expect(record).not.toHaveProperty('controllerId')
    expect(record).not.toHaveProperty('clientCount')

    // The process ends and the server restarts. No daemon attaches.
    await first.gateway.routeDaemonFrame(host, { type: 'agentExit', sessionId, code: 0 })
    await first.modules.sessions.flushBroadcasts()
    await first.dispose()
    registries.length = 0

    const second = await registryOver(store)
    await settle()
    // Nothing runs it here: the map holds running sessions only.
    expect(second.modules.sessions.sessions.has(sessionId)).toBe(false)

    const stored = await subscribe(second, 'session.terminalState', sessionId)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      type: 'topicSnapshot',
      payload: { controller: null, geometry: { cols: 132, rows: 43 }, exit: { code: 0 } },
    })
    const condition = await subscribe(second, 'session.condition', sessionId)
    expect(condition[0]).toMatchObject({
      type: 'topicSnapshot',
      payload: { busy: false, requestsGated: 0 },
    })
    // Subscribing read the row; it did not load the session.
    expect(second.modules.sessions.sessions.has(sessionId)).toBe(false)
  })

  it('serves the stored size for a running session whose daemon is offline after a restart', async () => {
    const store = await openTestStore(':memory:')
    const first = await registryOver(store)
    await attachHostDaemon(first, () => {})
    const { sessionId } = await first.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const host = first.sessionStore.hostMachineId
    await first.gateway.routeDaemonFrame(host, {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/w',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    await first.gateway.routeDaemonFrame(host, {
      type: 'geometryApplied',
      sessionId,
      geometry: { cols: 150, rows: 50 },
      cause: 'request',
    })
    await first.modules.sessions.flushBroadcasts()
    await first.dispose()
    registries.length = 0

    // The session is still meant to run, and no daemon has come back.
    const second = await registryOver(store)
    await settle()
    const frames = await subscribe(second, 'session.terminalState', sessionId)
    expect(frames[0]).toMatchObject({
      type: 'topicSnapshot',
      payload: { controller: null, geometry: { cols: 150, rows: 50 } },
    })
    expect(frames[0]).not.toHaveProperty('payload.exit')
  })

  it('refuses a session the subscriber may not see, exactly like a missing one', async () => {
    const store = await openTestStore(':memory:')
    const registry = await registryOver(store)
    await attachHostDaemon(registry, () => {})
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const stranger = await subscribe(registry, 'session.terminalState', sessionId, {
      userId: asUserId('someone-else'),
      userRole: 'member',
    })
    expect(stranger).toEqual([
      { type: 'topicClosed', key: topicKey('session.terminalState', sessionId), reason: 'refused' },
    ])
    const missing = await subscribe(
      registry,
      'session.terminalState',
      'no-such-session' as SessionId,
    )
    expect(missing).toEqual([
      {
        type: 'topicClosed',
        key: topicKey('session.terminalState', 'no-such-session'),
        reason: 'refused',
      },
    ])
  })
})
