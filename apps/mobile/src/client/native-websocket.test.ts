import { cookieCredentials } from '@podium/client-core/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('React Native WebSocket bearer injection', () => {
  it('authenticates only the exact scheme/host/port/client path and preserves options', async () => {
    const calls: unknown[][] = []
    class FakeWebSocket {
      constructor(...args: unknown[]) {
        calls.push(args)
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const socketAuth = await import('./native-websocket.native')
    socketAuth.configureNativeWebSocketCredential('https://podium.example', 'phone-token')
    socketAuth.installNativeWebSocketAuthentication()
    const TestSocket = globalThis.WebSocket as unknown as new (...args: unknown[]) => unknown

    new TestSocket('wss://podium.example/client?v=2', ['podium'], {
      headers: { 'X-Trace': 'one' },
    })
    new TestSocket('ws://podium.example/client?v=2', [], {
      headers: { 'X-Trace': 'two' },
    })
    new TestSocket('wss://other.example/socket', [], {
      headers: { 'X-Trace': 'three' },
    })

    expect(calls[0]?.[2]).toEqual({
      headers: { 'X-Trace': 'one', Authorization: 'Bearer phone-token' },
    })
    expect(calls[1]?.[2]).toEqual({ headers: { 'X-Trace': 'two' } })
    expect(calls[2]?.[2]).toEqual({ headers: { 'X-Trace': 'three' } })
  })
  it('the shared socket factory bypasses a stale ambient credential decorator', async () => {
    const calls: unknown[][] = []
    class FakeWebSocket { constructor(...args: unknown[]) { calls.push(args) } }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const socketAuth = await import('./native-websocket.native')
    socketAuth.configureNativeWebSocketCredential('https://podium.example', 'ambient-other-owner')
    socketAuth.installNativeWebSocketAuthentication()
    let released: string | null = 'this-owner'
    const make = socketAuth.makePlatformSocketLogin({
      credentials: { ...cookieCredentials, delivery: 'native' },
      httpOrigin: 'https://podium.example',
      bearer: () => released,
    })
    make('wss://podium.example/client')
    released = null
    make('wss://podium.example/client')
    expect(calls.map((args) => args[2])).toEqual([
      { headers: { Authorization: 'Bearer this-owner' } }, undefined,
    ])
  })

})
