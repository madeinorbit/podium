import { firstAdminMemberId } from '@podium/model'
import { MIN_CLIENT_WIRE_VERSION, CLIENT_WIRE_VERSION, DAEMON_WIRE_VERSION } from '@podium/protocol'
import { afterEach, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import {
  attachWebSockets,
  type NativeServer,
  serveNative,
  type WsHandle,
} from './gateway/ws-server'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

let server: Pick<NativeServer<never>, 'port' | 'stop'> | undefined
let handle: WsHandle | undefined
let store: SessionStore | undefined
let registry: SessionRegistry | undefined

afterEach(async () => {
  await handle?.close()
  void server?.stop(true)
  await registry?.dispose()
  await store?.close()
  server = handle = store = registry = undefined
})

/** Start a real native Bun server with an open client surface. */
async function start(): Promise<string> {
  store = await openTestStore(':memory:')
  registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  handle = attachWebSockets(registry, {
    userForClient: () => firstAdminMemberId(),
    roleForClient: () => 'admin',
  })
  server = serveNative({
    port: 0,
    hostname: '127.0.0.1',
    websocket: handle.websocket,
    async fetch(request, nativeServer) {
      const result = await handle?.handleRequest(request, nativeServer)
      return result === null ? new Response('not found', { status: 404 }) : result
    },
  })
  return `ws://127.0.0.1:${server.port}`
}

/** Resolve 'open' or 'rejected' for a connection attempt. */
function attempt(url: string): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const target = new URL(url)
    if (target.pathname === '/client') target.searchParams.append('cap', 'sync.http.v1')
    const ws = new WebSocket(target)
    ws.on('open', () => {
      ws.close()
      resolve('open')
    })
    ws.on('error', () => resolve('rejected'))
    ws.on('unexpected-response', () => resolve('rejected'))
  })
}

describe('WS version gate (?v with ?pv alias)', () => {
  test('rejects a too-old wire version (below MIN_CLIENT_WIRE_VERSION) with 426', async () => {
    const base = await start()
    expect(await attempt(`${base}/client?v=${MIN_CLIENT_WIRE_VERSION - 1}`)).toBe('rejected')
  })

  test('rejects a too-new wire version (above CLIENT_WIRE_VERSION) with 426', async () => {
    const base = await start()
    expect(await attempt(`${base}/client?v=${CLIENT_WIRE_VERSION + 1}`)).toBe('rejected')
  })

  test('accepts the current wire version (peer may upgrade to it)', async () => {
    const base = await start()
    expect(await attempt(`${base}/client?v=${CLIENT_WIRE_VERSION}`)).toBe('open')
  })

  test('accepts a peer that sends no version param (older client)', async () => {
    const base = await start()
    expect(await attempt(`${base}/client`)).toBe('open')
  })

  test('accepts the deprecated pv alias for a supported version', async () => {
    const base = await start()
    expect(await attempt(`${base}/client?pv=${CLIENT_WIRE_VERSION}`)).toBe('open')
  })
})


test.each(['/client', '/daemon', '/machine'])('accepts an overlapping newer range on %s', async (path) => {
  const base = await start()
  const max = path === '/client' ? CLIENT_WIRE_VERSION : DAEMON_WIRE_VERSION
  expect(await attempt(`${base}${path}?v=${encodeURIComponent(JSON.stringify({ min: 1, max: max + 1 }))}`)).toBe('open')
  expect(await attempt(`${base}${path}?v=${encodeURIComponent(JSON.stringify({ min: max + 1, max: max + 2 }))}`)).toBe('rejected')
})
