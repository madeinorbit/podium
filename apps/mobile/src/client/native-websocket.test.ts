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
})
