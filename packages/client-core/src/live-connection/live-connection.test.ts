import { describe, expect, it, vi } from 'vitest'
import { cookieCredentials } from '../accounts/storage'
import type { FeedServerFrame, FeedSinkPort, SocketHub, WebSocketLike, WireSkew } from '../socket-transport'
import {
  browserServerRelocation, createFeedRelay, createSocketLogin, observeLiveConnection,
  serverRelocationDestination, socketLoginOptions, type FeedBroadcastChannel,
} from './index'

function sink() {
  return { syncHttp: true, helloFields: () => null, connected: vi.fn(), disconnected: vi.fn(), frame: vi.fn(), requestRebootstrap: vi.fn() } satisfies FeedSinkPort
}
const delta = (seq: number): FeedServerFrame => ({ type: 'feedDelta', feedId: 'feed', epoch: 'epoch', fromSeq: seq - 1, seq, minAvailableSeq: 0, changes: [] })
function channels() {
  const peers = new Map<string, Set<FeedBroadcastChannel>>()
  const opened: (FeedBroadcastChannel & { posted: unknown[]; closed: boolean })[] = []
  const create = (name: string) => {
    const group = peers.get(name) ?? new Set<FeedBroadcastChannel>()
    peers.set(name, group)
    const channel = {
      onmessage: null as FeedBroadcastChannel['onmessage'], posted: [] as unknown[], closed: false,
      postMessage: (message: unknown) => {
        channel.posted.push(message)
        for (const peer of group) if (peer !== channel) peer.onmessage?.({ data: structuredClone(message) } as MessageEvent)
      },
      close: () => { channel.closed = true; group.delete(channel) },
    }
    group.add(channel)
    opened.push(channel)
    return channel
  }
  return { create, opened }
}

describe('shared feed relay', () => {
  it('converges two clients and consumes a racing socket duplicate only once', () => {
    const bus = channels(), first = sink(), second = sink()
    const options = { principal: '["installation","alice"]', channelName: 'database', createChannel: bus.create }
    const a = createFeedRelay(first, options), b = createFeedRelay(second, options)
    a.feed.frame(delta(1))
    b.feed.frame(delta(1))
    expect(first.frame).toHaveBeenCalledTimes(1)
    expect(second.frame).toHaveBeenCalledExactlyOnceWith(delta(1))
    expect(bus.opened.map((c) => c.posted.length)).toEqual([1, 0])
    a.dispose(); b.dispose()
  })

  it('does not cross an account or database boundary', () => {
    const bus = channels(), same = sink(), otherAccount = sink(), otherDatabase = sink()
    const a = createFeedRelay(same, { principal: 'alice', channelName: 'one', createChannel: bus.create })
    const b = createFeedRelay(otherAccount, { principal: 'bob', channelName: 'one', createChannel: bus.create })
    const c = createFeedRelay(otherDatabase, { principal: 'alice', channelName: 'two', createChannel: bus.create })
    a.feed.frame(delta(1))
    expect(otherAccount.frame).not.toHaveBeenCalled()
    expect(otherDatabase.frame).not.toHaveBeenCalled()
    bus.opened[0]!.onmessage?.({ data: { kind: 'podium-kernel-feed', version: 2, principal: 'alice', frame: delta(2) } } as MessageEvent)
    expect(same.frame).toHaveBeenCalledTimes(1)
    a.dispose(); b.dispose(); c.dispose()
  })

  it('shares rescope eviction but keeps resume and rebootstrap owned by the tab', () => {
    const bus = channels(), first = sink(), second = sink()
    const options = { principal: 'alice', channelName: 'one', createChannel: bus.create }
    const a = createFeedRelay(first, options), b = createFeedRelay(second, options)
    const rescope = { type: 'feedRescope', feedId: 'feed', epoch: 'epoch', seq: 2, evictions: [] } as unknown as FeedServerFrame
    a.feed.frame(rescope)
    b.feed.frame(rescope)
    const resume = { type: 'feedResume', feedId: 'feed', epoch: 'epoch', seq: 2 } as FeedServerFrame
    a.feed.frame(resume)
    a.feed.requestRebootstrap?.()
    expect(first.frame.mock.calls.map(([frame]) => frame.type)).toEqual(['feedRescope', 'feedResume'])
    expect(second.frame).toHaveBeenCalledExactlyOnceWith(rescope)
    expect(first.requestRebootstrap).toHaveBeenCalledOnce()
    expect(second.requestRebootstrap).not.toHaveBeenCalled()
    a.dispose(); b.dispose()
  })

  it('bounds deduplication history and separates epochs and delta starting positions', () => {
    const target = sink(), relay = createFeedRelay(target, { principal: 'alice', channelName: 'one' })
    for (let seq = 1; seq <= 513; seq++) relay.feed.frame(delta(seq))
    relay.feed.frame(delta(1))
    relay.feed.frame({ ...delta(1), epoch: 'new-epoch' })
    relay.feed.frame({ ...delta(1), fromSeq: 99 })
    expect(target.frame).toHaveBeenCalledTimes(516)
    relay.dispose()
  })

  it('cuts off retained socket/channel callbacks before principal erasure', () => {
    const bus = channels(), target = sink()
    const relay = createFeedRelay(target, { principal: 'alice', channelName: 'one', createChannel: bus.create })
    const stale = bus.opened[0]!.onmessage!
    relay.dispose(); relay.dispose()
    stale({ data: { kind: 'podium-kernel-feed', version: 1, principal: 'alice', frame: delta(1) } } as MessageEvent)
    relay.feed.frame(delta(2)); relay.feed.connected(true); relay.feed.requestRebootstrap?.()
    expect(target.frame).not.toHaveBeenCalled()
    expect(target.connected).not.toHaveBeenCalled()
    expect(target.requestRebootstrap).not.toHaveBeenCalled()
    expect(bus.opened[0]!.closed).toBe(true)
  })
})

describe('login carriage', () => {
  function socketCalls() {
    const calls: unknown[][] = []
    class Socket implements WebSocketLike {
      onopen = null; onmessage = null; onclose = null
      send() {}; close() {}
      constructor(...args: unknown[]) { calls.push(args) }
    }
    return { calls, Socket }
  }
  const native = { ...cookieCredentials, delivery: 'native' as const, get: vi.fn(async () => 'unreleased-secret') }

  it('leaves HttpOnly cookies to the browser constructor without exposing a token', () => {
    const { calls, Socket } = socketCalls(), bearer = vi.fn(() => 'must-not-read')
    createSocketLogin({ credentials: cookieCredentials, httpOrigin: 'https://one.test', bearer, Socket })('wss://one.test/client')
    expect(calls).toEqual([['wss://one.test/client']])
    expect(bearer).not.toHaveBeenCalled()
  })

  it('keeps two native owners isolated and observes revocation without reading storage', () => {
    const { calls, Socket } = socketCalls()
    let alice: string | null = 'alice-token'
    const a = createSocketLogin({ credentials: native, httpOrigin: 'https://one.test', bearer: () => alice, Socket })
    const b = createSocketLogin({ credentials: native, httpOrigin: 'https://two.test', bearer: () => 'bob-token', Socket })
    a('wss://one.test/client?v=4'); b('wss://two.test/client?v=4'); a('wss://two.test/client')
    alice = null; a('wss://one.test/client')
    expect(calls.map((args) => args[2])).toEqual([
      { headers: { Authorization: 'Bearer alice-token' } },
      { headers: { Authorization: 'Bearer bob-token' } }, undefined, undefined,
    ])
    expect(native.get).not.toHaveBeenCalled()
  })

  it.each(['ws://one.test:8443/client', 'wss://other.test:8443/client', 'wss://one.test/client', 'wss://one.test:8443/terminal', 'wss://one.test:8443/client/child', 'invalid'])('does not carry a bearer to %s', (url) => {
    const prior = { headers: { 'X-Trace': 'trace' }, custom: 1 }
    expect(socketLoginOptions(url, 'https://one.test:8443', 'secret', prior)).toBe(prior)
  })

  it('preserves native request options while setting the scoped Authorization header', () => {
    expect(socketLoginOptions('wss://one.test:8443/client?v=4', 'https://one.test:8443', 'secret', { headers: { 'X-Trace': 'trace' }, custom: 1 })).toEqual({ headers: { 'X-Trace': 'trace', Authorization: 'Bearer secret' }, custom: 1 })
  })
})

describe('relocation', () => {
  it('preserves the route and carries the cookie claim only in the fragment', () => {
    const next = '/issues?workspace=one#pane'
    expect(serverRelocationDestination('https://new.test/', next)).toBe('https://new.test/issues?workspace=one#pane')
    const destination = new URL(serverRelocationDestination('https://new.test', next, 'secret/+'))
    expect(destination.pathname).toBe('/auth/server-transfer-claim')
    expect(destination.search).toBe('')
    expect(new URLSearchParams(destination.hash.slice(1)).get('token')).toBe('secret/+')
    expect(new URLSearchParams(destination.hash.slice(1)).get('next')).toBe(next)
  })
  it('uses replace so the old authority is not left in browser history', () => {
    const replace = vi.fn()
    browserServerRelocation({ pathname: '/issues', search: '?workspace=one', hash: '#pane', replace })('https://new.test', 'transfer')
    expect(replace).toHaveBeenCalledExactlyOnceWith('https://new.test/issues?workspace=one#pane')
  })
})

describe('connection observers', () => {
  function hubSource() {
    type Status = 'down' | 'degraded' | 'ok'
    let connected = false
    const health = new Set<(h: { status: Status }) => void>(), skews = new Set<(s: WireSkew) => void>()
    const hub = {
      get connected() { return connected }, wake: vi.fn(), connectNow: vi.fn(), suspend: vi.fn(),
      onConnectionHealth: (cb: (h: { status: Status }) => void) => { health.add(cb); cb({ status: 'ok' }); return () => health.delete(cb) },
      onWireSkew: (cb: (s: WireSkew) => void) => { skews.add(cb); return () => skews.delete(cb) },
    } as unknown as SocketHub
    return { hub, health, skews, send: (status: Status) => { connected = status !== 'down'; for (const cb of health) cb({ status }) } }
  }
  it('runs recovery once per outage, never for RTT/degraded health or subscription replay', () => {
    const source = hubSource(), reconnected = vi.fn(), disconnected = vi.fn(), skew = vi.fn()
    const stop = observeLiveConnection(source.hub, { onReconnect: reconnected, onDisconnected: disconnected, onWireSkew: skew })
    source.send('degraded'); source.send('ok'); source.send('ok')
    expect(reconnected).not.toHaveBeenCalled(); expect(disconnected).not.toHaveBeenCalled()
    source.send('down'); source.send('down'); source.send('degraded'); source.send('ok'); source.send('ok')
    expect(reconnected).toHaveBeenCalledOnce()
    for (const cb of source.skews) cb({ quarantined: 1, refusedFrames: 0, since: 1 })
    expect(skew).toHaveBeenCalledOnce()
    stop(); source.send('down'); source.send('ok')
    expect(source.health.size).toBe(0); expect(source.skews.size).toBe(0)
    expect(reconnected).toHaveBeenCalledOnce()
  })
  it('wakes only after hiding and detaches the platform hub on cleanup', () => {
    const source = hubSource(), detach = vi.fn()
    let hidden = () => {}, shown = () => {}
    const stopWake = vi.fn(), attachHub = vi.fn(() => detach)
    const stop = observeLiveConnection(source.hub, {
      connectivity: { attachHub },
      wakeSource: { subscribe: (hide, show) => { hidden = hide; shown = show; return stopWake } },
    })
    shown(); hidden(); hidden(); shown(); shown()
    expect(source.hub.wake).toHaveBeenCalledOnce()
    expect(attachHub).toHaveBeenCalledExactlyOnceWith(source.hub)
    stop(); stop()
    expect(detach).toHaveBeenCalledOnce(); expect(stopWake).toHaveBeenCalledOnce()
  })
})
