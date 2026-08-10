import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { type ServerMessage, WIRE_VERSION } from '@podium/protocol'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import {
  attachWebSockets,
  type NativeServer,
  serveNative,
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
async function start(authorizeClient: (request: Request) => boolean) {
  store = new SessionStore(':memory:')
  registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
  handle = attachWebSockets(registry, {
    authorizeClient,
    userForClient: () => FIRST_ADMIN_USER_ID,
    roleForClient: () => 'admin',
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

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for websocket publication')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function connectDeltaClient(url: string) {
  const frames: string[] = []
  const ws = new WebSocket(url)
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
  test('serves session state only through the wire-v2 feed', async () => {
    const url = await start(() => true)
    if (!registry) throw new Error('missing test registry')
    const sessionId = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/feed-only',
    }).sessionId
    registry.modules.sessions.flushBroadcasts()

    const client = await connectDeltaClient(url)
    await until(() => client.frames.some((raw) => JSON.parse(raw).type === 'feedBootstrap'))
    registry.modules.sessions.renameSession({ sessionId, name: 'feed-only-renamed' })
    registry.modules.sessions.flushBroadcasts()
    await until(() => client.frames.some((raw) => JSON.parse(raw).type === 'feedDelta'))

    const entityFrames = client.frames.map((raw) => JSON.parse(raw) as ServerMessage)
    const bootstrap = entityFrames.find((message) => message.type === 'feedBootstrap')
    const delta = entityFrames.find((message) => message.type === 'feedDelta')
    expect(bootstrap).toMatchObject({
      type: 'feedBootstrap',
      changes: [{ entity: 'session', entityId: sessionId, op: 'upsert' }],
    })
    expect(delta).toMatchObject({
      type: 'feedDelta',
      changes: [{ entity: 'session', entityId: sessionId, op: 'upsert' }],
    })
    expect(entityFrames.map((message) => message.type)).not.toContain('sessionsChanged')
    expect(entityFrames.map((message) => message.type)).not.toContain('metadataDelta')
    client.ws.close()
  })
})
