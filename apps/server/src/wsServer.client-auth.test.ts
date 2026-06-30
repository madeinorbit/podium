import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'
import { attachWebSockets, type WsHandle } from './wsServer'

let server: Server | undefined
let handle: WsHandle | undefined
let store: SessionStore | undefined

afterEach(async () => {
  await handle?.close()
  await new Promise<void>((res) => (server ? server.close(() => res()) : res()))
  store?.close()
  server = handle = store = undefined
})

/** Start a real http server with the client-auth gate, return its /client URL. */
async function start(authorizeClient: (req: { headers: Record<string, unknown> }) => boolean) {
  store = new SessionStore(':memory:')
  const registry = new SessionRegistry(store)
  server = createServer()
  handle = attachWebSockets(server as Server, registry, {
    // biome-ignore lint/suspicious/noExplicitAny: test double for IncomingMessage
    authorizeClient: authorizeClient as any,
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

  test('a foreign browser Origin is rejected even when the auth gate would allow it', async () => {
    const url = await start(() => true)
    expect(await attempt(url, { origin: 'https://evil.example' })).toBe('rejected')
    // No Origin (native client) still connects.
    expect(await attempt(url)).toBe('open')
  })
})
