import { asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { type MetadataChange, type ServerMessage, WIRE_VERSION } from '@podium/protocol'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import {
  attachWebSockets,
  type NativeServer,
  serveNative,
  type WsAuthOptions,
  type WsHandle,
} from './gateway/ws-server'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

let server: Pick<NativeServer<never>, 'port' | 'stop'> | undefined
let handle: WsHandle | undefined
let store: SessionStore | undefined
let registry: SessionRegistry | undefined

afterEach(async () => {
  await handle?.close()
  void server?.stop(true)
  registry?.dispose()
  store?.close()
  server = handle = store = registry = undefined
})

/** Start a real Bun server with the client-auth gate, return its /client URL. */
async function start(
  authorizeClient: (request: Request) => boolean,
  resolvePublicationAuthority?: NonNullable<WsAuthOptions['resolvePublicationAuthority']>,
) {
  store = new SessionStore(':memory:')
  registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
  handle = attachWebSockets(registry, {
    authorizeClient,
    userForClient: () => FIRST_ADMIN_USER_ID,
    roleForClient: () => 'admin',
    ...(resolvePublicationAuthority ? { resolvePublicationAuthority } : {}),
  })
  server = serveNative({
    port: 0,
    hostname: '127.0.0.1',
    websocket: handle.websocket,
    fetch(request, nativeServer) {
      const result = handle?.handleRequest(request, nativeServer)
      return result === null ? new Response('not found', { status: 404 }) : result
    },
  })
  return `ws://127.0.0.1:${server.port}/client`
}

function attempt(url: string, headers?: Record<string, string>): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    ws.on('open', () => {
      ws.close()
      resolve('open')
    })
    ws.on('error', () => resolve('rejected'))
    ws.on('unexpected-response', () => resolve('rejected'))
  })
}

function receiveSessionIds(url: string, world: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-world': world } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('timed out waiting for scoped session publication'))
    }, 5_000)
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage
      if (message.type !== 'sessionsChanged') return
      clearTimeout(timer)
      ws.close()
      resolve(message.sessions.map((session) => session.sessionId))
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for websocket publication')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function connectDeltaClient(url: string, world: string) {
  const frames: string[] = []
  const ws = new WebSocket(url, { headers: { 'x-world': world } })
  ws.on('message', (raw) => frames.push(raw.toString()))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          clientId: '',
          viewport: { cols: 80, rows: 24, dpr: 1 },
          caps: ['metadataDelta'],
          wireVersion: WIRE_VERSION,
        }),
      )
      resolve()
    })
    ws.on('error', reject)
  })
  return { frames, ws }
}

function sessionStateFrames(frames: string[]): string[] {
  return frames.filter((raw) => {
    const type = (JSON.parse(raw) as ServerMessage).type
    return type === 'sessionsChanged' || type === 'metadataDelta' || type === 'sessionViewDelta'
  })
}

describe('/client WS auth gate', () => {
  test('accepts the client when the gate authorizes it', async () => {
    const url = await start(() => true)
    expect(await attempt(url)).toBe('open')
  })

  test('rejects the client upgrade when the gate denies it', async () => {
    const url = await start(() => false)
    expect(await attempt(url)).toBe('rejected')
  })

  test('the gate sees the upgrade request cookie header', async () => {
    const url = await start((req) => req.headers.get('cookie') === 'podium_session=good')
    expect(await attempt(url, { cookie: 'podium_session=good' })).toBe('open')
    expect(await attempt(url, { cookie: 'podium_session=bad' })).toBe('rejected')
  })

  test('no gate configured keeps the client surface open (back-compat)', async () => {
    const url = await start(undefined as never)
    expect(await attempt(url)).toBe('open')
  })

  test('a loopback-bound backend accepts any Origin (proxy owns origin policy)', async () => {
    // The test server binds 127.0.0.1, so its Host is loopback — the same shape as a backend
    // behind tailscale/nginx/caddy. A foreign Origin must NOT be rejected here, or every
    // reverse-proxied client would break; SameSite=Lax on the cookie is the real CSWSH guard.
    // (Same-origin enforcement only applies when bound to a real network host — unit-tested in
    // wsServer.origin.test.ts.)
    const url = await start(() => true)
    expect(await attempt(url, { origin: 'https://evil.example' })).toBe('open')
    expect(await attempt(url)).toBe('open')
  })
  test('resolves distinct publication worlds from real upgrade requests', async () => {
    let aliceSession = ''
    let bobSession = ''
    const url = await start(
      () => true,
      (req) => {
        const principal = String(req.headers.get('x-world'))
        const allowedSessionIds =
          principal === 'alice' ? [aliceSession] : principal === 'bob' ? [bobSession] : []
        return {
          principal,
          scope: 'principal:' + principal,
          serverRole: 'standalone',
          protocolVersion: 1,
          global: false,
          snapshot: () => ({
            revision: 1,
            allowedSignature: JSON.stringify(allowedSessionIds),
            allowedSessionIds,
          }),
        }
      },
    )
    if (!registry) throw new Error('missing test registry')
    aliceSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/alice-only',
    }).sessionId
    bobSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/bob-only',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const [alice, bob] = await Promise.all([
      receiveSessionIds(url, 'alice'),
      receiveSessionIds(url, 'bob'),
    ])
    expect(alice).toEqual([aliceSession])
    expect(bob).toEqual([bobSession])
  })

  test('filters every real socket delta through its scoped world', async () => {
    let aliceSession = ''
    let bobSession = ''
    const url = await start(
      () => true,
      (req) => {
        const principal = String(req.headers.get('x-world'))
        const allowedSessionIds =
          principal === 'alice' ? [aliceSession] : principal === 'bob' ? [bobSession] : []
        return {
          principal,
          scope: 'principal:' + principal,
          serverRole: 'standalone',
          protocolVersion: 1,
          global: false,
          snapshot: () => ({
            revision: 1,
            allowedSignature: JSON.stringify(allowedSessionIds),
            allowedSessionIds,
          }),
        }
      },
    )
    if (!registry) throw new Error('missing test registry')
    aliceSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/alice-visible',
    }).sessionId
    bobSession = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/bob-hidden-secret',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const [alice, bob] = await Promise.all([
      connectDeltaClient(url, 'alice'),
      connectDeltaClient(url, 'bob'),
    ])
    await until(
      () =>
        sessionStateFrames(alice.frames).length === 1 &&
        sessionStateFrames(bob.frames).length === 1,
    )

    registry.modules.sessions.renameSession({
      sessionId: asSessionId(bobSession),
      name: 'BOB-SECRET',
    })
    registry.modules.sessions.flushBroadcasts()
    await until(
      () =>
        sessionStateFrames(alice.frames).length === 2 &&
        sessionStateFrames(bob.frames).length === 2,
    )

    const aliceHidden = sessionStateFrames(alice.frames)[1] ?? ''
    const bobVisible = sessionStateFrames(bob.frames)[1] ?? ''
    expect(JSON.parse(aliceHidden)).toMatchObject({ type: 'metadataDelta', changes: [] })
    expect(aliceHidden).not.toContain(bobSession)
    expect(aliceHidden).not.toContain('BOB-SECRET')
    expect(JSON.parse(bobVisible)).toMatchObject({
      type: 'metadataDelta',
      changes: [{ entity: 'session', id: bobSession, op: 'upsert' }],
    })

    const cursor = registry.modules.sessions.syncChangesSince(null).cursor
    deliverToEveryClient(registry, [
      { seq: cursor + 1, entity: 'issue', id: 'hidden-issue', op: 'remove' },
      {
        seq: cursor + 2,
        entity: 'conversation',
        id: 'hidden-conversation',
        op: 'remove',
      },
    ])
    await until(
      () =>
        sessionStateFrames(alice.frames).length === 3 &&
        sessionStateFrames(bob.frames).length === 3,
    )
    for (const scoped of [alice, bob]) {
      const hiddenEntities = sessionStateFrames(scoped.frames)[2] ?? ''
      expect(JSON.parse(hiddenEntities)).toMatchObject({ type: 'metadataDelta', changes: [] })
      expect(hiddenEntities).not.toContain('hidden-issue')
      expect(hiddenEntities).not.toContain('hidden-conversation')
    }

    alice.ws.close()
    bob.ws.close()
  })
})

/**
 * Deliver ONE `metadataDelta` to every connected client through the real sink.
 *
 * WAS `sessions.sendMetadataDelta(changes)`, which both framed the batch and
 * routed it. Framing moved to the serving edge at POD-1203; ROUTING — which is
 * what these cases are about, since they assert what a SCOPED publication client
 * receives — is still the sessions service's, so this drives exactly that half
 * with exactly the message a v1 delta peer's adapter produces.
 */
function deliverToEveryClient(
  registry: { modules: { sessions: { deliverEntityMessage: (conn: never, msg: never) => void } } },
  changes: MetadataChange[],
): void {
  const sessions = registry.modules.sessions as unknown as {
    deliverEntityMessage: (conn: unknown, msg: unknown) => void
    onFeedPublished: (seq: number) => void
    clients: { values(): IterableIterator<unknown> }
  }
  const seq = changes[changes.length - 1]?.seq ?? 0
  // Position first, delivery second — the funnel's order, and the reason a
  // scoped client's worker has a range to publish at all.
  sessions.onFeedPublished(seq)
  for (const conn of [...sessions.clients.values()]) {
    sessions.deliverEntityMessage(conn, { type: 'metadataDelta', seq, changes })
  }
}
