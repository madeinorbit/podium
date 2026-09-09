/**
 * The parent-child lifecycle wire (POD-3761), both ends, over a fake peer.
 *
 * The real descriptor is proved in lifecycle-channel.integration.test.ts with
 * real processes; these pin the protocol: what each end sends, what it ignores,
 * what it records, and the supervisor-death seam POD-3774 will fill in.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  attachChildChannel,
  connectLifecycleChannel,
  decodeChildMessage,
  decodeParentMessage,
  encodeLifecycle,
  LIFECYCLE_HEARTBEAT_MS,
  LIFECYCLE_PROTOCOL,
  NODE_CHANNEL_FD_ENV,
  supervisorDeathSignal,
  withoutLifecycleChannel,
} from './lifecycle-channel'
import type { IntervalScheduler } from './supervisor'

/** One end of a channel: what it sent, and a way to deliver to it. */
class FakePeer extends EventEmitter {
  sent: unknown[] = []
  connected = true
  send(message: unknown): boolean {
    if (!this.connected) throw new Error('channel closed')
    this.sent.push(message)
    return true
  }
  deliver(message: unknown): void {
    this.emit('message', message)
  }
  disconnect(): void {
    this.connected = false
    this.emit('disconnect')
  }
}

/** The client under test exists: this process's transport has a channel by construction. */
function connected<T>(client: T | undefined): T {
  if (client === undefined) throw new Error('expected a connected lifecycle client')
  return client
}

/** A hand-cranked interval, so heartbeat cadence is asserted, not awaited. */
function manualScheduler(): IntervalScheduler & { fire: () => void; intervals: number[] } {
  const callbacks: Array<() => void> = []
  const intervals: number[] = []
  return {
    intervals,
    every: (ms, callback) => {
      intervals.push(ms)
      callbacks.push(callback)
      return () => callbacks.splice(callbacks.indexOf(callback), 1)
    },
    fire: () => {
      for (const callback of [...callbacks]) callback()
    },
  }
}

describe('wire', () => {
  it('stamps every frame with the protocol marker and decodes only stamped, well-formed frames', () => {
    const frame = encodeLifecycle({ type: 'heartbeat' as const })
    expect(frame.podium).toBe(LIFECYCLE_PROTOCOL)
    expect(decodeChildMessage(frame)).toEqual({ type: 'heartbeat' })
    // Unstamped: something else on the pipe, never ours to act on.
    expect(decodeChildMessage({ type: 'heartbeat' })).toBeUndefined()
    // Stamped but malformed: a pid that is not a pid.
    expect(
      decodeChildMessage(
        encodeLifecycle({ type: 'ready', role: 'server', pid: -1, version: '1.0.0' }),
      ),
    ).toBeUndefined()
    // Non-objects.
    expect(decodeChildMessage('ready')).toBeUndefined()
    expect(decodeChildMessage(null)).toBeUndefined()
    expect(decodeParentMessage(encodeLifecycle({ type: 'stop', reason: 'topology' }))).toEqual({
      type: 'stop',
      reason: 'topology',
    })
    expect(decodeParentMessage(encodeLifecycle({ type: 'ready' }))).toBeUndefined()
  })
})

describe('parent end', () => {
  it('sends identity the moment it attaches, so a child never has to ask', () => {
    const peer = new FakePeer()
    attachChildChannel(peer, {
      identity: {
        generation: 7,
        machineId: 'm-1',
        assignment: { server: true, agentExecution: true },
      },
    })
    expect(peer.sent).toEqual([
      {
        podium: LIFECYCLE_PROTOCOL,
        type: 'identity',
        generation: 7,
        machineId: 'm-1',
        assignment: { server: true, agentExecution: true },
      },
    ])
  })

  it('records ready, degraded, heartbeat and stopping with the time each arrived', () => {
    const peer = new FakePeer()
    let now = 1_000
    const reports: unknown[] = []
    const channel = attachChildChannel(peer, {
      identity: { generation: 1 },
      now: () => now,
      onReport: (report) => reports.push(report),
    })
    expect(channel.report()).toEqual({ channel: 'open' })

    peer.deliver(
      encodeLifecycle({
        type: 'ready',
        role: 'server',
        pid: 4242,
        version: '1.2.3',
        digest: 'abc',
        port: 18787,
      }),
    )
    now = 2_000
    peer.deliver(encodeLifecycle({ type: 'heartbeat' }))
    now = 3_000
    peer.deliver(encodeLifecycle({ type: 'degraded', reason: 'recovery-only' }))
    now = 4_000
    peer.deliver(encodeLifecycle({ type: 'stopping', reason: 'SIGTERM' }))

    expect(channel.report()).toEqual({
      channel: 'open',
      ready: {
        role: 'server',
        pid: 4242,
        version: '1.2.3',
        digest: 'abc',
        port: 18787,
        atMs: 1_000,
      },
      lastHeartbeatMs: 2_000,
      degraded: { reason: 'recovery-only', atMs: 3_000 },
      stopping: { reason: 'SIGTERM', atMs: 4_000 },
    })
    expect(reports).toHaveLength(4)
  })

  it('ignores frames that are not lifecycle frames', () => {
    const peer = new FakePeer()
    const channel = attachChildChannel(peer, { identity: { generation: 1 } })
    peer.deliver({ type: 'ready', role: 'server', pid: 1, version: 'x' })
    peer.deliver('hello')
    peer.deliver(encodeLifecycle({ type: 'identity', generation: 9 }))
    expect(channel.report()).toEqual({ channel: 'open' })
  })

  it('marks the channel closed on disconnect and refuses to send after it', () => {
    const peer = new FakePeer()
    const channel = attachChildChannel(peer, { identity: { generation: 1 }, now: () => 5_000 })
    peer.disconnect()
    expect(channel.report()).toEqual({ channel: 'closed', closedAtMs: 5_000 })
    expect(channel.stop('topology')).toBe(false)
    expect(peer.sent).toHaveLength(1)
  })

  it('sends stop with its reason', () => {
    const peer = new FakePeer()
    const channel = attachChildChannel(peer, { identity: { generation: 1 } })
    expect(channel.stop('topology: daemon retired')).toBe(true)
    expect(peer.sent[1]).toEqual({
      podium: LIFECYCLE_PROTOCOL,
      type: 'stop',
      reason: 'topology: daemon retired',
    })
  })

  it('is a no-op over a peer that was spawned without a channel', () => {
    const noChannel = new EventEmitter() as EventEmitter & { pid: number }
    const channel = attachChildChannel(noChannel, { identity: { generation: 1 } })
    expect(channel.report()).toEqual({ channel: 'none' })
    expect(channel.stop('x')).toBe(false)
  })

  it('stops listening once detached', () => {
    const peer = new FakePeer()
    const channel = attachChildChannel(peer, { identity: { generation: 1 } })
    channel.detach()
    peer.deliver(encodeLifecycle({ type: 'heartbeat' }))
    expect(channel.report().lastHeartbeatMs).toBeUndefined()
    expect(peer.listenerCount('message')).toBe(0)
    expect(peer.listenerCount('disconnect')).toBe(0)
  })
})

describe('child end', () => {
  it('is absent when this process has no channel — an unsupervised run', () => {
    const transport = new EventEmitter()
    expect(
      connectLifecycleChannel({
        role: 'server',
        version: 'dev',
        transport,
        scheduler: manualScheduler(),
      }),
    ).toBeUndefined()
  })

  it('reports ready with its identity, then degraded and stopping, in the wire shape', () => {
    const transport = new FakePeer()
    const client = connected(
      connectLifecycleChannel({
        role: 'daemon',
        version: '1.2.3',
        digest: 'sha',
        pid: 77,
        transport,
        scheduler: manualScheduler(),
      }),
    )
    expect(client.ready({ port: 18787 })).toBe(true)
    expect(client.degraded('server unreachable')).toBe(true)
    expect(client.stopping('SIGTERM')).toBe(true)
    expect(transport.sent).toEqual([
      {
        podium: LIFECYCLE_PROTOCOL,
        type: 'ready',
        role: 'daemon',
        pid: 77,
        version: '1.2.3',
        digest: 'sha',
        port: 18787,
      },
      { podium: LIFECYCLE_PROTOCOL, type: 'degraded', reason: 'server unreachable' },
      { podium: LIFECYCLE_PROTOCOL, type: 'stopping', reason: 'SIGTERM' },
    ])
  })

  it('heartbeats on the contract cadence until closed', () => {
    const transport = new FakePeer()
    const scheduler = manualScheduler()
    const client = connected(
      connectLifecycleChannel({ role: 'server', version: 'dev', transport, scheduler }),
    )
    expect(scheduler.intervals).toEqual([LIFECYCLE_HEARTBEAT_MS])
    scheduler.fire()
    scheduler.fire()
    expect(transport.sent.filter((m) => (m as { type: string }).type === 'heartbeat')).toHaveLength(
      2,
    )
    client.close()
    scheduler.fire()
    expect(transport.sent.filter((m) => (m as { type: string }).type === 'heartbeat')).toHaveLength(
      2,
    )
  })

  it('keeps the identity the parent sent and hands stop to the shutdown hook, with its reason', () => {
    const transport = new FakePeer()
    const client = connected(
      connectLifecycleChannel({
        role: 'server',
        version: 'dev',
        transport,
        scheduler: manualScheduler(),
      }),
    )
    const identities: unknown[] = []
    const stops: string[] = []
    client.onIdentity((identity) => identities.push(identity))
    client.onStop((reason) => stops.push(reason))
    expect(client.identity()).toBeUndefined()
    transport.deliver(encodeLifecycle({ type: 'identity', generation: 3, machineId: 'm' }))
    transport.deliver({ type: 'stop', reason: 'not ours' })
    transport.deliver(encodeLifecycle({ type: 'stop', reason: 'topology' }))
    expect(client.identity()).toEqual({ generation: 3, machineId: 'm' })
    expect(identities).toEqual([{ generation: 3, machineId: 'm' }])
    expect(stops).toEqual(['topology'])
  })

  it('a send over a dead channel reports false rather than throwing into the caller', () => {
    const transport = new FakePeer()
    const client = connected(
      connectLifecycleChannel({
        role: 'server',
        version: 'dev',
        transport,
        scheduler: manualScheduler(),
      }),
    )
    transport.connected = false
    expect(client.ready()).toBe(false)
  })

  describe('supervisor death seam', () => {
    it('treats channel close as the supervisor dying on POSIX, and not on Windows', () => {
      expect(supervisorDeathSignal('linux')).toBe('disconnect')
      expect(supervisorDeathSignal('darwin')).toBe('disconnect')
      // POD-3760 finding b / POD-3774: Windows fires no disconnect, and the CI
      // evidence cannot say what a real desktop does. Off until it can.
      expect(supervisorDeathSignal('win32')).toBe('none')
    })

    it("fires onSupervisorGone once on disconnect when the seam says 'disconnect'", () => {
      const transport = new FakePeer()
      const scheduler = manualScheduler()
      const client = connected(
        connectLifecycleChannel({
          role: 'server',
          version: 'dev',
          transport,
          scheduler,
          deathSignal: 'disconnect',
        }),
      )
      let gone = 0
      client.onSupervisorGone(() => gone++)
      transport.disconnect()
      transport.emit('disconnect')
      expect(gone).toBe(1)
      // The heartbeat has nobody to reach; it must not keep firing into a closed pipe.
      scheduler.fire()
      expect(
        transport.sent.filter((m) => (m as { type: string }).type === 'heartbeat'),
      ).toHaveLength(0)
    })

    it("stays silent on disconnect when the seam says 'none'", () => {
      const transport = new FakePeer()
      const client = connected(
        connectLifecycleChannel({
          role: 'server',
          version: 'dev',
          transport,
          scheduler: manualScheduler(),
          deathSignal: 'none',
        }),
      )
      let gone = 0
      client.onSupervisorGone(() => gone++)
      transport.disconnect()
      expect(gone).toBe(0)
    })
  })
})

describe('withoutLifecycleChannel', () => {
  it("drops node's channel-descriptor variable and nothing else, without mutating the source", () => {
    const source = { [NODE_CHANNEL_FD_ENV]: '3', PODIUM_PORT: '1' }
    const env = withoutLifecycleChannel(source)
    expect(env).toEqual({ PODIUM_PORT: '1' })
    expect(source[NODE_CHANNEL_FD_ENV]).toBe('3')
  })
})
