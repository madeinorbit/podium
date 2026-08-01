import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { attachWebSockets, isAllowedWsOrigin, type WsHandle } from './gateway/ws-server'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

describe('isAllowedWsOrigin', () => {
  test('a request with no Origin (native client / daemon) is allowed', () => {
    expect(isAllowedWsOrigin(undefined, 'podium.example.com')).toBe(true)
  })

  test('a same-origin browser request (Origin host == Host) is allowed', () => {
    expect(isAllowedWsOrigin('https://podium.example.com', 'podium.example.com')).toBe(true)
    expect(isAllowedWsOrigin('http://1.2.3.4:18787', '1.2.3.4:18787')).toBe(true)
  })

  test('the desktop webview origin (tauri://localhost) is allowed', () => {
    expect(isAllowedWsOrigin('tauri://localhost', '127.0.0.1:54321')).toBe(true)
  })

  test('loopback origins are allowed (local dev / bundled app)', () => {
    expect(isAllowedWsOrigin('http://localhost:5173', '127.0.0.1:18787')).toBe(true)
    expect(isAllowedWsOrigin('http://127.0.0.1:18787', '127.0.0.1:18787')).toBe(true)
  })

  test('a foreign cross-site origin is rejected on direct (network-host) exposure', () => {
    expect(isAllowedWsOrigin('https://evil.example', 'podium.example.com')).toBe(false)
  })

  test('same hostname on a different port is allowed (TLS terminator forwards a diff port)', () => {
    expect(isAllowedWsOrigin('https://box.tailnet.ts.net:55555', 'box.tailnet.ts.net:18787')).toBe(
      true,
    )
  })

  test('any origin is allowed when the backend Host is loopback (behind a reverse proxy)', () => {
    // tailscale serve / nginx / caddy proxy with changeOrigin rewrites Host to localhost, so
    // Origin can never equal Host — the edge owns origin policy. Must NOT reject the real client.
    expect(isAllowedWsOrigin('https://box.tailnet.ts.net', 'localhost:18787')).toBe(true)
    expect(isAllowedWsOrigin('https://box.tailnet.ts.net', '127.0.0.1:18787')).toBe(true)
  })

  test('a malformed Origin is rejected', () => {
    expect(isAllowedWsOrigin('not a url', 'podium.example.com')).toBe(false)
  })
})

/**
 * THE GUARD, WIRED (POD-391).
 *
 * Everything above tests the PREDICATE. Nothing tested that the upgrade handler
 * calls it — and the one wiring test that existed
 * (`wsServer.client-auth.test.ts`, "a loopback-bound backend accepts any Origin")
 * asserts the PERMISSIVE branch, which passes just as well with the guard deleted.
 * Deleting the `isAllowedWsOrigin` call from `ws-server.ts` was therefore a
 * surviving mutant across the whole suite: mechanism present, CSWSH uncovered.
 *
 * The enforcing branch only runs when the backend's own `Host` is a real network
 * host (see the predicate's doc: behind a proxy the edge owns origin policy), and
 * a test server necessarily binds loopback. So these forge the `Host` header —
 * node routes the request by socket, not by `Host`, so the connection still lands
 * on our server while the guard sees the direct-exposure shape it gates on.
 */
describe('the CSWSH guard on the real upgrade path', () => {
  let server: Server | undefined
  let handle: WsHandle | undefined
  let store: SessionStore | undefined
  let registry: SessionRegistry | undefined

  afterEach(async () => {
    await handle?.close()
    await new Promise<void>((res) => {
      if (!server) return res()
      // Bun's node:http keeps upgraded sockets tracked after terminate(), so
      // close() would never call back. Force them shut (a no-op under Node).
      server.closeAllConnections?.()
      server.close(() => res())
    })
    registry?.dispose()
    store?.close()
    server = handle = store = registry = undefined
  })

  async function start(): Promise<string> {
    store = new SessionStore(':memory:')
    registry = new SessionRegistry(store)
    server = createServer()
    handle = attachWebSockets(server as Server, registry, {
      userForClient: () => FIRST_ADMIN_USER_ID,
      roleForClient: () => 'admin',
    })
    await new Promise<void>((res) => (server as Server).listen(0, res))
    return `ws://127.0.0.1:${(server?.address() as AddressInfo).port}`
  }

  /** Resolve 'open' or 'rejected', with `Host` forged to a real network name. */
  function attempt(url: string, origin?: string): Promise<'open' | 'rejected'> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, {
        headers: { host: 'podium.example.com', ...(origin ? { origin } : {}) },
      })
      ws.on('open', () => {
        ws.close()
        resolve('open')
      })
      ws.on('error', () => resolve('rejected'))
      ws.on('unexpected-response', () => resolve('rejected'))
    })
  }

  test('a foreign browser Origin is refused at the /client upgrade', async () => {
    const base = await start()
    expect(await attempt(`${base}/client`, 'https://evil.example')).toBe('rejected')
  })

  test('a foreign browser Origin is refused at the /daemon upgrade too', async () => {
    // The guard sits above the path split and both peer planes are behind it. A
    // fix applied to one branch only would leave the other plane hijackable.
    const base = await start()
    expect(await attempt(`${base}/daemon`, 'https://evil.example')).toBe('rejected')
  })

  test('the same-origin browser is still admitted (the guard is not a blanket refusal)', async () => {
    // Without this, "rejected" above is satisfied by a server that refuses every
    // upgrade — the refusal has to be attributable to the Origin, not to the
    // forged Host or to the harness.
    const base = await start()
    expect(await attempt(`${base}/client`, 'https://podium.example.com')).toBe('open')
  })

  test('a native peer sending no Origin is still admitted', async () => {
    // The daemon and every non-browser client send no Origin. If the guard reaped
    // those, the fleet would be unreachable on any directly-exposed deployment.
    const base = await start()
    expect(await attempt(`${base}/daemon`)).toBe('open')
  })
})
