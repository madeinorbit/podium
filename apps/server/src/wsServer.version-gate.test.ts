import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
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

/** Start a real native Bun server with an open client surface. */
async function start(): Promise<string> {
  store = new SessionStore(':memory:')
  registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
  handle = attachWebSockets(registry, {
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
  return `ws://127.0.0.1:${server.port}`
}

/** Resolve 'open' or 'rejected' for a connection attempt. */
function attempt(url: string): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on('open', () => {
      ws.close()
      resolve('open')
    })
    ws.on('error', () => resolve('rejected'))
    ws.on('unexpected-response', () => resolve('rejected'))
  })
}

describe('WS version gate (?v with ?pv alias)', () => {
  test('rejects a too-old wire version (below MIN_SUPPORTED_VERSION) with 426', async () => {
    const base = await start()
    expect(await attempt(`${base}/client?v=${MIN_SUPPORTED_VERSION - 1}`)).toBe('rejected')
  })

  test('rejects a too-new wire version (above WIRE_VERSION) with 426', async () => {
    const base = await start()
    expect(await attempt(`${base}/client?v=${WIRE_VERSION + 1}`)).toBe('rejected')
  })

  test('accepts the current wire version (peer may upgrade to it)', async () => {
    const base = await start()
    expect(await attempt(`${base}/client?v=${WIRE_VERSION}`)).toBe('open')
  })

  test('accepts a peer that sends no version param (older client)', async () => {
    const base = await start()
    expect(await attempt(`${base}/client`)).toBe('open')
  })

  test('accepts the deprecated pv alias for a supported version', async () => {
    const base = await start()
    expect(await attempt(`${base}/client?pv=${WIRE_VERSION}`)).toBe('open')
  })
})
