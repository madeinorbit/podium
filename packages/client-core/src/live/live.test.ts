import { asMutationId, type HostMetricsWire } from '@podium/model'
import { encode, type ServerMessage, type TopicKind } from '@podium/protocol'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { SocketHub, type WebSocketLike } from '../socket-transport/socket-hub'
import type { TopicListener, TopicState } from '../socket-transport/subscriptions'
import {
  LiveFeed,
  type LiveFeedHub,
  type LiveFeedMachines,
  type LiveFrameScheduler,
} from './live-feed'
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

class FakeMachines implements LiveFeedMachines {
  list: string[] = []
  private listeners = new Set<() => void>()
  ids(): readonly string[] {
    return this.list
  }
  subscribe(changed: () => void): () => void {
    this.listeners.add(changed)
    return () => this.listeners.delete(changed)
  }
  set(ids: string[]): void {
    this.list = ids
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeHub implements LiveFeedHub {
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
  // The machines the feed follows are the replica's machine records (POD-6644).
  const machines = new FakeMachines()
  feed = new LiveFeed({ hub, machines, live, userId: 'me', scheduler: frames, now: () => 2_000 })
  return { hub, machines, frames, live, feed }
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
  it('counts only this account’s unsynced and recoverable writes, following drain and discard', () => {
    const alice = new LiveStore()
    const bob = new LiveStore()
    const seen: number[] = []
    const stop = autorun(() => seen.push(alice.unsyncedChangeCount))
    const parked = {
      entry: { mutationId: asMutationId('parked'), kind: 'recordEdit', input: {}, queuedAt: 1 },
      reason: { code: 'invalid' as const },
      parkedFrom: 'rejected' as const,
      deadLetteredAt: 2,
      attempts: 1,
    }
    try {
      bob.setOutbox({ pending: 5, deadLetters: [] })
      alice.setOutbox({ pending: 2, deadLetters: [parked] })
      expect(alice.unsyncedChangeCount).toBe(3)
      expect(bob.unsyncedChangeCount).toBe(5)
      alice.setOutbox({ pending: 0, deadLetters: [parked] })
      expect(alice.unsyncedChangeCount).toBe(1)
      alice.setOutbox({ pending: 0, deadLetters: [] })
      expect(seen).toEqual([0, 3, 1, 0])
    } finally {
      stop()
      alice.dispose()
      bob.dispose()
    }
  })

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
    const { hub, machines, feed } = setup()
    machines.list = ['m1']
    feed.start()
    expect([...hub.held.keys()].sort()).toEqual(['account.quota:me', 'machine.condition:m1'])
    machines.set(['m2'])
    expect([...hub.held.keys()].sort()).toEqual(['account.quota:me', 'machine.condition:m2'])
    feed.stop()
    expect(hub.held.size).toBe(0)
  })

  it('applies readings at most once per frame, the newest per key winning', () => {
    const { hub, machines, frames, live, feed } = setup()
    machines.list = ['m1']
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
  })
})
