import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'
import { attachWebSockets, type WsAuthOptions, type WsHandle } from './wsServer'

let server: Server | undefined
let handle: WsHandle | undefined
let store: SessionStore | undefined
let registry: SessionRegistry | undefined

afterEach(async () => {
  await handle?.close()
  await new Promise<void>((res) => {
    if (!server) return res()
    // Bun's node:http keeps accepted (upgraded) sockets tracked even after the ws
    // layer terminate()s them, so server.close() would wait forever for its callback.
    // Force the lingering sockets shut first — a no-op under Node, where close() drains.
    server.closeAllConnections?.()
    server.close(() => res())
  })
  registry?.dispose()
  store?.close()
  server = handle = store = registry = undefined
})

/** Start a real http server with the client-auth gate, return its /client URL. */
async function start(
  authorizeClient: (req: { headers: Record<string, unknown> }) => boolean,
  resolvePublicationAuthority?: NonNullable<WsAuthOptions['resolvePublicationAuthority']>,
) {
  store = new SessionStore(':memory:')
  registry = new SessionRegistry(store)
  server = createServer()
  handle = attachWebSockets(server as Server, registry, {
    // biome-ignore lint/suspicious/noExplicitAny: test double for IncomingMessage
    authorizeClient: authorizeClient as any,
    ...(resolvePublicationAuthority ? { resolvePublicationAuthority } : {}),
  })
  await new Promise<void>((res) => (server as Server).listen(0, res))
  const port = (server?.address() as AddressInfo).port
  return `ws://127.0.0.1:${port}/client`
}

/** Resolve 'open' or 'rejected' for a connection attempt. */
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
    const url = await start((req) => req.headers.cookie === 'podium_session=good')
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
        const principal = String(req.headers['x-world'])
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
})
