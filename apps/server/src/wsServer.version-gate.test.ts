import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
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

/** Start a real http server with an open client surface; return its base ws origin. */
async function start(): Promise<string> {
  store = new SessionStore(':memory:')
  const registry = new SessionRegistry(store)
  server = createServer()
  handle = attachWebSockets(server as Server, registry)
  await new Promise<void>((res) => (server as Server).listen(0, res))
  const port = (server?.address() as AddressInfo).port
  return `ws://127.0.0.1:${port}`
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
