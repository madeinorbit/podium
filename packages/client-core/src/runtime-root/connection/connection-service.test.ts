// @vitest-environment happy-dom
import type { TopicKind } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../../api'
import { LiveFrameQueue, type LiveFrameScheduler } from '../../live/frame-queue'
import { LiveFeed } from '../../live/live-feed'
import { LiveStore } from '../../live/live-store'
import type { Replica } from '../../replica/kernel/facade'
import type { FeedSinkPort, SocketHub } from '../../socket-transport'
import type { ConnectionHealth, ServerIdentity } from '../../socket-transport/socket-hub'
import type { TopicListener, TopicState } from '../../socket-transport/subscriptions'
import { ConnectionService } from './connection-service'
import type { VisibilitySource } from './visibility'

/**
 * THE CONNECTION SERVICE (POD-6681): the socket, its dial and reconnects, and
 * the connection condition in the LiveStore, moved out of the old store.
 */

/** A scheduler the test flushes by hand: one call is one frame. */
class ManualFrames implements LiveFrameScheduler {
  private pending: (() => void)[] = []
  enqueue(work: () => void): void {
    this.pending.push(work)
  }
  flush(): void {
    const batch = this.pending
    this.pending = []
    for (const work of batch) work()
  }
  dispose(): void {
    this.pending = []
  }
}

class FakeHub {
  connected = false
  health: ConnectionHealth = { status: 'ok', rttMs: null, since: 0 }
  identity: ServerIdentity | null = null
  skew: number | null = null
  connects = 0
  connectNows = 0
  disposes = 0
  readonly held = new Map<string, TopicListener<unknown>>()
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  subscribeTopic<K extends TopicKind>(
    kind: K,
    id: string,
    listener: TopicListener<never>,
  ): () => void {
    const key = `${kind}:${id}`
    this.held.set(key, listener as TopicListener<unknown>)
    listener.onState?.({ status: 'pending' } as never)
    return () => {
      this.held.delete(key)
    }
  }
  state(key: string, state: TopicState<unknown>): void {
    this.held.get(key)?.onState?.(state)
  }
  connectionHealth(): ConnectionHealth {
    return this.health
  }
  serverIdentity(): ServerIdentity | null {
    return this.identity
  }
  clockSkewMs(): number | null {
    return this.skew
  }
  connect(): void {
    this.connects += 1
  }
  connectNow(): void {
    this.connectNows += 1
  }
  dispose(): void {
    this.disposes += 1
  }
  on(event: string, handler: (...args: never[]) => void): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as (...args: unknown[]) => void)
    return () => set.delete(handler as (...args: unknown[]) => void)
  }
  listeners(event: string): number {
    return this.handlers.get(event)?.size ?? 0
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args)
  }
}

function fakeVisibility(initial: boolean): VisibilitySource & {
  set(visible: boolean): void
  subscribers(): number
} {
  let visible = initial
  const listeners = new Set<() => void>()
  return {
    isVisible: () => visible,
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    set: (next) => {
      visible = next
      for (const cb of [...listeners]) cb()
    },
    subscribers: () => listeners.size,
  }
}

/** A server's feature facts as `welcome` carries them (POD-6677). */
const facts = (...ids: string[]) => ({
  devMode: false,
  developmentBuild: false,
  flags: ids.map((id) => ({ id, name: id, description: '', visibility: 'stable' as const })),
})

const position = { epoch: 'e', seq: 1 }
const services: ConnectionService[] = []

function setup(options: { networkEnabled?: boolean; visible?: boolean } = {}) {
  const hub = new FakeHub()
  const scheduler = new ManualFrames()
  const frames = new LiveFrameQueue(scheduler)
  const visibility = fakeVisibility(options.visible ?? true)
  const live = new LiveStore({ now: () => 1_000 })
  const fatal: string[] = []
  const connection = new ConnectionService({
    wsClientUrl: 'ws://x',
    api: {} as PodiumClientApi,
    replica: {} as Replica,
    live,
    frames,
    onFatalError: (m) => fatal.push(m),
    formatError: (_e, f) => f,
    networkEnabled: options.networkEnabled ?? true,
    visibility,
    feed: {} as FeedSinkPort,
    createHub: () => hub as unknown as SocketHub,
  })
  services.push(connection)
  const topics = new LiveFeed({
    hub: connection.hub,
    machines: { ids: () => [], subscribe: () => () => {} },
    live,
    userId: 'me',
    frames,
    now: () => 2_000,
  })
  return { hub, frames: scheduler, live, connection, topics, visibility, fatal }
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
})

describe('the connection condition in the LiveStore', () => {
  it('marks every reading unknown when the connection is declared lost, keeping the last value', () => {
    const { hub, frames, live, connection, topics } = setup()
    topics.start()
    connection.start()
    hub.state('account.quota:me', {
      status: 'value',
      value: { machines: [] },
      position,
    })
    hub.connected = true
    hub.emit('connectionHealth', hub.health)
    frames.flush()
    expect(live.connection.state).toBe('online')
    expect(live.quota.known).toBe(true)
    hub.connected = false
    hub.health = { status: 'down', rttMs: null, since: 3_000 }
    hub.emit('connectionHealth', hub.health)
    frames.flush()
    expect(live.connection).toMatchObject({ state: 'offline', since: 3_000 })
    expect(live.quota).toEqual({ known: false, last: { machines: [] }, since: 3_000 })
  })

  it('carries ping, skew and the server identity, and a redeploy replaces the build', () => {
    const { hub, frames, live, connection } = setup()
    connection.start()
    hub.connected = true
    hub.health = { status: 'ok', rttMs: 12, since: 0 }
    hub.skew = -40
    hub.identity = { build: 'one', features: facts('x') }
    hub.emit('serverIdentity', hub.identity)
    frames.flush()
    expect(live.connection).toMatchObject({
      state: 'online',
      pingMs: 12,
      skewMs: -40,
      serverBuild: 'one',
      serverFeatures: facts('x'),
    })
    hub.identity = { build: 'two', features: facts('x', 'y') }
    hub.emit('serverIdentity', hub.identity)
    frames.flush()
    expect(live.connection.serverBuild).toBe('two')
    expect(live.connection.serverFeatures).toEqual(facts('x', 'y'))
  })

  it('writes nothing without network: the condition stays where it was born', () => {
    const { hub, frames, live, connection } = setup({ networkEnabled: false })
    connection.start()
    hub.connected = true
    hub.emit('connectionHealth', hub.health)
    frames.flush()
    expect(live.connection.state).toBe('connecting')
  })
})

describe('dial and reconnect', () => {
  it('dials once, on the next macrotask after start', () => {
    vi.useFakeTimers()
    const { hub, connection } = setup()
    connection.start()
    expect(hub.connects).toBe(0)
    vi.runAllTimers()
    expect(hub.connects).toBe(1)
  })

  it('reconnects when the client comes back on screen, after the other visibility listeners', () => {
    const { hub, connection, visibility } = setup({ visible: false })
    const order: string[] = []
    connection.onVisibilityChange(() => order.push(`listener:${hub.connectNows}`))
    connection.start()
    visibility.set(true)
    expect(order).toEqual(['listener:0'])
    expect(hub.connectNows).toBe(1)
    visibility.set(false)
    expect(hub.connectNows).toBe(1)
  })

  it('reconnects when the browser says the network came back', () => {
    const { hub, connection } = setup()
    connection.start()
    window.dispatchEvent(new Event('online'))
    expect(hub.connectNows).toBe(1)
  })

  it('reports the health returning, not every healthy reading', () => {
    const { hub, connection } = setup()
    const returned = vi.fn()
    connection.onReconnected(returned)
    connection.start()
    hub.emit('connectionHealth', { status: 'ok', rttMs: 5, since: 1 })
    expect(returned).not.toHaveBeenCalled()
    hub.emit('connectionHealth', { status: 'down', rttMs: null, since: 2 })
    hub.emit('connectionHealth', { status: 'ok', rttMs: 5, since: 3 })
    expect(returned).toHaveBeenCalledOnce()
    hub.emit('connectionHealth', { status: 'degraded', rttMs: 900, since: 4 })
    hub.emit('connectionHealth', { status: 'ok', rttMs: 5, since: 5 })
    expect(returned).toHaveBeenCalledTimes(2)
  })

  it('neither dials nor reconnects without network, yet still reports visibility', () => {
    vi.useFakeTimers()
    const { hub, connection, visibility } = setup({ networkEnabled: false, visible: false })
    const seen = vi.fn()
    connection.onVisibilityChange(seen)
    connection.start()
    visibility.set(true)
    window.dispatchEvent(new Event('online'))
    vi.runAllTimers()
    expect(seen).toHaveBeenCalledOnce()
    expect(hub.connects).toBe(0)
    expect(hub.connectNows).toBe(0)
  })
})

describe('lifecycle', () => {
  it('starts nothing twice across a StrictMode remount (start, stop, start)', () => {
    vi.useFakeTimers()
    const { hub, connection, visibility } = setup()
    connection.start()
    connection.start()
    connection.stop()
    connection.start()
    vi.runAllTimers()
    expect(hub.connects).toBe(1)
    expect(visibility.subscribers()).toBe(1)
    expect(hub.listeners('connectionHealth')).toBe(2)
    visibility.set(true)
    expect(hub.connectNows).toBe(1)
  })

  it('a stop before the dial cancels it, and stops are idempotent', () => {
    vi.useFakeTimers()
    const { hub, connection } = setup()
    connection.start()
    connection.stop()
    connection.stop()
    vi.runAllTimers()
    expect(hub.connects).toBe(0)
    expect(hub.disposes).toBe(1)
  })

  it('fires nothing after sign-out and never starts again', () => {
    vi.useFakeTimers()
    const { hub, frames, live, connection, visibility } = setup()
    const seen = vi.fn()
    const returned = vi.fn()
    connection.onVisibilityChange(seen)
    connection.onReconnected(returned)
    connection.start()
    frames.flush()
    const before = live.connection
    connection.dispose()
    expect(connection.isDisposed).toBe(true)
    connection.start()
    vi.runAllTimers()
    visibility.set(false)
    visibility.set(true)
    window.dispatchEvent(new Event('online'))
    hub.connected = true
    hub.emit('connectionHealth', { status: 'down', rttMs: null, since: 2 })
    hub.emit('connectionHealth', { status: 'ok', rttMs: 5, since: 3 })
    frames.flush()
    expect(hub.connects).toBe(0)
    expect(hub.connectNows).toBe(0)
    expect(seen).not.toHaveBeenCalled()
    expect(returned).not.toHaveBeenCalled()
    expect(visibility.subscribers()).toBe(0)
    expect(live.connection).toBe(before)
  })
})
