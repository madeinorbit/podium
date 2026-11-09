import type { HostMetricsWire, MachineWire } from '@podium/model'
import { encode, type ServerMessage, type TopicKind } from '@podium/protocol'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import type { ConnectionHealth, ServerIdentity } from '../socket-transport/socket-hub'
import { SocketHub, type WebSocketLike } from '../socket-transport/socket-hub'
import type { TopicListener, TopicState } from '../socket-transport/subscriptions'
import { LiveFeed, type LiveFeedHub, type LiveFrameScheduler } from './live-feed'
import { LiveStore } from './live-store'

/**
 * THE LIVESTORE (POD-5798): conditions, never saved, unknown until their first
 * reading, written once per frame by the live feed.
 */

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  recv(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
  pings(): number {
    return this.sent.filter((frame) => (JSON.parse(frame) as { type: string }).type === 'ping')
      .length
  }
}

/** A scheduler the test flushes by hand: one call is one frame. */
class ManualFrames implements LiveFrameScheduler {
  private pending: (() => void)[] = []
  frames = 0
  enqueue(work: () => void): void {
    this.pending.push(work)
  }
  flush(): void {
    const batch = this.pending
    this.pending = []
    if (batch.length > 0) this.frames += 1
    for (const work of batch) work()
  }
  dispose(): void {
    this.pending = []
  }
}

class FakeHub implements LiveFeedHub {
  connected = false
  health: ConnectionHealth = { status: 'ok', rttMs: null, since: 0 }
  identity: ServerIdentity | null = null
  skew: number | null = null
  machineList: MachineWire[] = []
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
  machines(): MachineWire[] {
    return this.machineList
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
  on(event: string, handler: (...args: never[]) => void): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as (...args: unknown[]) => void)
    return () => set.delete(handler as (...args: unknown[]) => void)
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args)
  }
}

const position = { epoch: 'e', seq: 1 }
const sample = (machineId: string, at = '2026-11-08T12:00:00Z') =>
  ({ machineId, hostname: machineId, sampledAt: at }) as HostMetricsWire

function setup() {
  const hub = new FakeHub()
  const frames = new ManualFrames()
  let feed: LiveFeed | undefined
  const live = new LiveStore({
    now: () => 1_000,
    onMetricsDemand: (id, on) => feed?.watchMetrics(id, on),
    onUsageDemand: (on) => feed?.watchUsage(on),
  })
  feed = new LiveFeed({ hub, live, userId: 'me', scheduler: frames, now: () => 2_000 })
  return { hub, frames, live, feed }
}

/** A server's feature facts as `welcome` carries them (POD-6677). */
const facts = (...ids: string[]) => ({
  devMode: false,
  developmentBuild: false,
  flags: ids.map((id) => ({ id, name: id, description: '', visibility: 'stable' as const })),
})

describe('the hub learns the server (welcome and pong)', () => {
  it('names the server build on every welcome, so a redeploy shows after the reconnect', () => {
    const socket = new FakeSocket()
    const hub = new SocketHub({ url: 'ws://x', makeSocket: () => socket })
    const seen: (string | undefined)[] = []
    hub.on('serverIdentity', (identity) => seen.push(identity.build))
    hub.connect()
    socket.open()
    socket.recv({
      type: 'welcome',
      clientId: 'c1',
      serverBuild: '0.1.0+one',
      serverFeatures: facts('a'),
    })
    expect(hub.serverIdentity()).toEqual({ build: '0.1.0+one', features: facts('a') })
    // The redeploy: the socket drops, the new server answers the reconnect.
    socket.recv({
      type: 'welcome',
      clientId: 'c2',
      serverBuild: '0.1.0+two',
      serverFeatures: facts('a'),
    })
    expect(seen).toEqual(['0.1.0+one', '0.1.0+two'])
    expect(hub.serverIdentity()?.build).toBe('0.1.0+two')
    hub.dispose()
  })

  it('keeps an attach welcome without identity from erasing the known build', () => {
    const socket = new FakeSocket()
    const hub = new SocketHub({ url: 'ws://x', makeSocket: () => socket })
    hub.connect()
    socket.open()
    socket.recv({ type: 'welcome', clientId: 'c1', serverBuild: 'b1' })
    socket.recv({ type: 'welcome', clientId: 'c1' })
    expect(hub.serverIdentity()?.build).toBe('b1')
    hub.dispose()
  })

  it('reads clock skew from a pong that carries the server clock, and none from an old server', () => {
    const socket = new FakeSocket()
    const hub = new SocketHub({ url: 'ws://x', makeSocket: () => socket })
    hub.connect()
    socket.open()
    expect(socket.pings()).toBeGreaterThan(0)
    socket.recv({ type: 'pong' })
    expect(hub.clockSkewMs()).toBeNull()
    hub.dispose()
    const socket2 = new FakeSocket()
    const hub2 = new SocketHub({ url: 'ws://x', makeSocket: () => socket2 })
    hub2.connect()
    socket2.open()
    // The server's clock reads ten minutes ahead of ours.
    socket2.recv({ type: 'pong', serverTime: Date.now() + 600_000 })
    expect(hub2.clockSkewMs()).toBeGreaterThanOrEqual(599_000)
    expect(hub2.clockSkewMs()).toBeLessThanOrEqual(601_000)
    hub2.dispose()
  })
})

describe('LiveStore', () => {
  it('starts with every reading unknown and nothing remembered', () => {
    const live = new LiveStore({ now: () => 5 })
    expect(live.connection).toEqual({ state: 'connecting', since: 5 })
    expect(live.quota).toEqual({ known: false, since: 5 })
    expect(live.outbox).toEqual({ pending: 0, deadLetters: [] })
    expect(live.machineConditions.size).toBe(0)
    expect(live.machineMetrics.size).toBe(0)
    expect(live.quotaUsedUpUntil).toBeNull()
  })

  it('derives "used up until" from the latest reset of a window at 100%', () => {
    const live = new LiveStore()
    const window = (usedPercent: number, resetsAt: string) => ({
      key: `w${resetsAt}`,
      label: 'w',
      usedPercent,
      resetsAt,
      windowMinutes: 300,
    })
    live.applyTopic('account.quota', 'me', {
      known: true,
      at: 1,
      value: {
        machines: [
          {
            machineId: 'm1' as never,
            machineName: 'm1',
            hostname: 'm1',
            agents: [
              {
                agent: 'claude-code',
                status: 'ok',
                fetchedAt: '',
                windows: [window(100, '2026-11-08T15:00:00Z'), window(40, '2026-11-09T00:00:00Z')],
              },
            ],
          },
        ],
      },
    })
    expect(live.quotaUsedUpUntil).toBe('2026-11-08T15:00:00Z')
  })
})

describe('LiveFeed', () => {
  it('holds account.quota and every known machine for its lifetime, and releases them on stop', () => {
    const { hub, feed } = setup()
    hub.machineList = [{ id: 'm1' } as MachineWire]
    feed.start()
    expect([...hub.held.keys()].sort()).toEqual(['account.quota:me', 'machine.condition:m1'])
    hub.machineList = [{ id: 'm2' } as MachineWire]
    hub.emit('machines', hub.machineList)
    expect([...hub.held.keys()].sort()).toEqual(['account.quota:me', 'machine.condition:m2'])
    feed.stop()
    expect(hub.held.size).toBe(0)
  })

  it('applies readings at most once per frame, the newest per key winning', () => {
    const { hub, frames, live, feed } = setup()
    hub.machineList = [{ id: 'm1' } as MachineWire]
    feed.start()
    frames.flush()
    const applied: unknown[] = []
    const stop = autorun(() => applied.push(live.conditionOf('m1')))
    applied.length = 0
    hub.state('machine.condition:m1', {
      status: 'value',
      value: { online: false, since: null },
      position,
    })
    hub.state('machine.condition:m1', {
      status: 'value',
      value: { online: true, since: 'later' },
      position,
    })
    expect(live.conditionOf('m1')?.known).toBe(false)
    frames.flush()
    expect(applied).toHaveLength(1)
    expect(live.conditionOf('m1')).toMatchObject({
      known: true,
      value: { online: true, since: 'later' },
    })
    stop()
  })

  it('marks every reading unknown when the connection is declared lost, keeping the last value', () => {
    const { hub, frames, live, feed } = setup()
    feed.start()
    hub.state('account.quota:me', {
      status: 'value',
      value: { machines: [] },
      position,
    })
    hub.connected = true
    hub.emit('connectionHealth')
    frames.flush()
    expect(live.connection.state).toBe('online')
    expect(live.quota.known).toBe(true)
    hub.connected = false
    hub.health = { status: 'down', rttMs: null, since: 3_000 }
    hub.emit('connectionHealth')
    frames.flush()
    expect(live.connection).toMatchObject({ state: 'offline', since: 3_000 })
    expect(live.quota).toEqual({ known: false, last: { machines: [] }, since: 3_000 })
  })

  it('carries ping, skew and the server identity, and a redeploy replaces the build', () => {
    const { hub, frames, live, feed } = setup()
    feed.start()
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

  it('holds a machine metrics topic only while a reader watches it', () => {
    const { hub, frames, live, feed } = setup()
    feed.start()
    let seen: HostMetricsWire | undefined
    const stop = autorun(() => {
      const reading = live.metricsOf('m1')
      seen = reading?.known ? reading.value : undefined
    })
    expect(hub.held.has('machine.metrics:m1')).toBe(true)
    hub.state('machine.metrics:m1', { status: 'value', value: sample('m1'), position })
    frames.flush()
    expect(seen?.machineId).toBe('m1')
    stop()
    expect(hub.held.has('machine.metrics:m1')).toBe(false)
    frames.flush()
    // An unwatched reading is dropped, never left to go stale silently.
    expect(live.machineMetrics.has('m1')).toBe(false)
  })

  it('holds account.usage only while a usage reader watches, keeping the last reading after', () => {
    const { hub, frames, live, feed } = setup()
    feed.start()
    expect(hub.held.has('account.usage:me')).toBe(false)
    let buckets: unknown
    const stop = autorun(() => {
      const reading = live.usage()
      buckets = reading.known ? reading.value?.buckets : undefined
    })
    expect(hub.held.has('account.usage:me')).toBe(true)
    hub.state('account.usage:me', {
      status: 'value',
      value: { hostname: 'h', buckets: [] },
      position,
    })
    frames.flush()
    expect(buckets).toEqual([])
    stop()
    // Nobody reads usage: the key is released, so the server harvests nothing.
    expect(hub.held.has('account.usage:me')).toBe(false)
    frames.flush()
    // The next reader's first frame still has "last read".
    const reading = live.usage()
    expect(reading.known).toBe(false)
    expect(!reading.known && reading.last).toEqual({ hostname: 'h', buckets: [] })
    // A fresh subscribe's pending state keeps that last value too.
    const again = autorun(() => live.usage())
    frames.flush()
    const kept = live.usage()
    expect(!kept.known && kept.last).toEqual({ hostname: 'h', buckets: [] })
    again()
  })

  it('writes the outbox counts with the frame', () => {
    const { frames, live, feed } = setup()
    feed.setOutbox({ pending: 3, deadLetters: [] })
    expect(live.outbox.pending).toBe(0)
    frames.flush()
    expect(live.outbox.pending).toBe(3)
  })

  it('is inert after dispose, and the disposed store forgets its readings', () => {
    const { hub, frames, live, feed } = setup()
    feed.start()
    hub.state('account.quota:me', {
      status: 'value',
      value: { machines: [] },
      position,
    })
    frames.flush()
    feed.dispose()
    live.dispose()
    expect(hub.held.size).toBe(0)
    expect(live.isDisposed).toBe(true)
    expect(live.quota.known).toBe(false)
    feed.setOutbox({ pending: 9, deadLetters: [] })
    frames.flush()
    expect(live.outbox.pending).toBe(0)
  })
})
