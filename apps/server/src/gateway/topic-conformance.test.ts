/**
 * The D25 conformance suite, run for every declared topic kind, plus the
 * POD-5800 acceptance checks that need the whole chain (client hub, server
 * routing, fake daemon). The harness is `test-support/topic-conformance.ts`.
 */

import {
  CAP_TOPICS_V1,
  checkoutTopicId,
  TOPIC_KIND_NAMES,
  type TopicKind,
  topicKey,
} from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HIBERNATION_HOLDER, HibernationMetricsDemand } from '../modules/hosts/metrics-demand'
import {
  createTopicWorld,
  describeTopicConformance,
  holdTopic,
  MACHINE,
  OTHER_MACHINE,
  OTHER_USER,
  SAMPLE_INTERVAL_MS,
  settle,
  type TopicConformanceCase,
  type TopicWorld,
  USER,
} from '../test-support/topic-conformance'
import { userClientPrincipal } from './client-principal'
import type { ClientConn } from './client-registry'

const VALUE_CASES = [
  {
    kind: 'checkout.changed',
    id: checkoutTopicId(MACHINE, '/checkout'),
    hiddenId: checkoutTopicId(OTHER_MACHINE, '/checkout'),
    revocable: true,
    prepare: async (world) => await world.attachDaemon(),
    produce: async (world) => {
      world.daemon.sample()
      await settle()
    },
    describeValue: () => 'changed',
  } satisfies TopicConformanceCase<'checkout.changed'>,
  {
    kind: 'machine.processes',
    id: MACHINE,
    hiddenId: OTHER_MACHINE,
    revocable: true,
    prepare: async (world) => await world.attachDaemon(),
    produce: async (world) => {
      world.daemon.sample()
      await settle()
    },
    describeValue: (value) => value.breakdown.sampledAt,
  } satisfies TopicConformanceCase<'machine.processes'>,
  {
    kind: 'machine.metrics',
    id: MACHINE,
    hiddenId: OTHER_MACHINE,
    revocable: true,
    prepare: async (world) => await world.attachDaemon(),
    produce: async (world) => {
      world.daemon.sample()
      await settle()
    },
    describeValue: (value) => value.sampledAt,
  } satisfies TopicConformanceCase<'machine.metrics'>,
  {
    kind: 'machine.condition',
    id: MACHINE,
    hiddenId: OTHER_MACHINE,
    revocable: true,
    prepare: async (world) => await world.attachDaemon(),
    produce: async (world) => {
      await world.detachDaemon()
      await world.attachDaemon()
    },
    describeValue: (value) => `${value.online}@${value.since}`,
  } satisfies TopicConformanceCase<'machine.condition'>,
] as const

for (const c of VALUE_CASES) describeTopicConformance(c as TopicConformanceCase<TopicKind>)

/** The event style has no value to coalesce or go unknown; its own cases. */
const EVENT_KINDS: readonly TopicKind[] = ['account.events']

describe('topic conformance: totality (D17)', () => {
  it('every declared kind has a conformance run', () => {
    const covered = new Set<TopicKind>([...VALUE_CASES.map((c) => c.kind), ...EVENT_KINDS])
    expect([...covered].sort()).toEqual([...TOPIC_KIND_NAMES].sort())
  })
})

describe('topic conformance: account.events (event style)', () => {
  let world: TopicWorld
  beforeEach(async () => {
    vi.useFakeTimers()
    world = await createTopicWorld()
  })
  afterEach(() => {
    world.dispose()
    vi.useRealTimers()
  })

  it('a topics client holds its own account.events after welcome and gets a snapshot ack', async () => {
    const client = await world.client()
    await settle()
    const key = topicKey('account.events', USER)
    expect(client.frames('topicSnapshot', key)).toHaveLength(1)
    expect(world.subscriptions.subscribers(`topic:account.events:${USER}` as never)).toHaveLength(1)
  })

  it('a notice reaches the holder on the topic, through the handler of the frame it replaces', async () => {
    const client = await world.client()
    await settle()
    const attention = vi.fn()
    client.hub.on('attention', attention)
    const conn = client.conn()!
    world.clients.deliverAccountEvent(conn, {
      type: 'attentionEvent',
      sessionId: 's-1' as never,
      title: 'Needs you',
      body: 'Waiting',
    })
    expect(client.frames('topicEvent', topicKey('account.events', USER))).toHaveLength(1)
    expect(client.frames('attentionEvent')).toHaveLength(0)
    await settle()
    expect(attention).toHaveBeenCalledWith({
      sessionId: 's-1',
      title: 'Needs you',
      body: 'Waiting',
    })
  })

  it('a connection that does not hold the key gets the pre-topics frame (fallback)', async () => {
    const sent: unknown[] = []
    const legacy = {
      id: 'legacy',
      principal: userClientPrincipal('legacy', USER, 'admin'),
      send: (msg: unknown) => sent.push(msg),
    } as unknown as ClientConn
    world.clients.add(legacy)
    world.clients.deliverAccountEvent(legacy, { type: 'setLogLevel', level: 'debug' })
    expect(sent).toEqual([{ type: 'setLogLevel', level: 'debug' }])
  })

  it("refuses another account's events like a missing key", async () => {
    const client = await world.client()
    const other = holdTopic(client, 'account.events', OTHER_USER)
    await settle()
    expect(other.states.at(-1)).toMatchObject({ status: 'closed', reason: 'refused' })
    expect(
      world.subscriptions.subscribers(`topic:account.events:${OTHER_USER}` as never),
    ).toHaveLength(0)
  })
})

describe('POD-5800 acceptance across the chain', () => {
  let world: TopicWorld
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    world?.dispose()
    vi.useRealTimers()
  })

  it('with no subscriber a capable daemon sends no host-metric frames during a full sampling interval', async () => {
    world = await createTopicWorld()
    await world.attachDaemon()
    await world.client()
    const before = world.daemon.samples
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 3)
    expect(world.daemon.samples).toBe(before)
    expect(world.daemon.watches).toEqual([])
  })

  it('a daemon without topics keeps the old path, and topic subscribers are served from it', async () => {
    world = await createTopicWorld({ daemonTopics: false })
    await world.attachDaemon()
    const client = await world.client()
    const held = holdTopic(client, 'machine.metrics', MACHINE)
    await settle()
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 2)
    // No demand is sent to a daemon that cannot read it …
    expect(world.daemon.watches).toEqual([])
    // … it samples on its own, and the subscriber still gets the value.
    expect(world.daemon.samples).toBeGreaterThanOrEqual(2)
    expect(held.states.at(-1)?.status).toBe('value')
  })

  it('a client without topics.v1 still gets the hostMetricsChanged broadcast', async () => {
    world = await createTopicWorld({ daemonTopics: false })
    const sent: unknown[] = []
    world.clients.add({
      id: 'legacy-client',
      principal: userClientPrincipal('legacy-client', USER, 'admin'),
      send: (msg: unknown) => sent.push(msg),
      caps: new Set<string>(),
    } as unknown as ClientConn)
    await world.attachDaemon()
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS)
    expect(sent.some((msg) => (msg as { type: string }).type === 'hostMetricsChanged')).toBe(true)
    // A topics client in the same world never gets it.
    const client = await world.client()
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS)
    expect(client.frames('hostMetricsChanged')).toEqual([])
    expect(client.conn()?.caps.has(CAP_TOPICS_V1)).toBe(true)
  })

  it('a machine going offline or online reaches a subscribed client within 1 s', async () => {
    world = await createTopicWorld()
    await world.attachDaemon()
    const client = await world.client()
    const held = holdTopic(client, 'machine.condition', MACHINE)
    await settle()
    expect(held.states.at(-1)).toMatchObject({ status: 'value', value: { online: true } })
    await world.detachDaemon()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(held.states.at(-1)).toMatchObject({ status: 'value', value: { online: false } })
    // Right after: the rate rule holds the next change, but never past 1 s.
    await world.attachDaemon()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(held.states.at(-1)).toMatchObject({ status: 'value', value: { online: true } })
  })

  it('a freshly started client shows unknown until the snapshot, never a stale value', async () => {
    world = await createTopicWorld()
    await world.attachDaemon()
    const client = await world.client()
    const states: string[] = []
    client.hub.subscribeTopic('machine.condition', MACHINE, {
      onState: (state) => states.push(state.status),
    })
    expect(states).toEqual(['pending'])
    await settle()
    expect(states).toEqual(['pending', 'value'])
  })

  it('the server-side pressure sweep is a named subscriber; off, and nobody watching, means no samples', async () => {
    world = await createTopicWorld()
    let enabled = true
    const demand = new HibernationMetricsDemand({
      hold: (id) => world.topics.hold(HIBERNATION_HOLDER, 'machine.metrics', id),
      release: (id) => world.topics.release(HIBERNATION_HOLDER, 'machine.metrics', id),
      enabled: async () => enabled,
      onlineMachineIds: () => (world.daemon.connected ? [MACHINE] : []),
    })
    await world.attachDaemon()
    await demand.connected(MACHINE)
    await settle()
    const key = `topic:machine.metrics:${MACHINE}`
    expect(
      world.subscriptions.subscribers(key as never).map((s) => String(s.subscriberId)),
    ).toEqual([`server:${HIBERNATION_HOLDER}`])
    expect(world.daemon.watching).toBe(1)
    enabled = false
    await demand.reevaluate()
    await settle()
    const before = world.daemon.samples
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 2)
    expect(world.daemon.samples).toBe(before)
    expect(world.daemon.watches.at(-1)).toEqual({
      type: 'topicWatch',
      key: topicKey('machine.metrics', MACHINE),
      on: false,
    })
  })

  it('releasing topic keys first means presence forgetting the subscriber cannot strand a sampler', async () => {
    world = await createTopicWorld()
    await world.attachDaemon()
    const client = await world.client()
    holdTopic(client, 'machine.metrics', MACHINE)
    await settle()
    expect(world.daemon.watching).toBe(1)
    const conn = client.conn()!
    // The mux order: topics.disconnect, then presence's dropSubscriber.
    world.topics.disconnect(conn)
    world.subscriptions.dropSubscriber(conn.id as never)
    await settle()
    expect(world.daemon.watching).toBe(0)
  })
})
