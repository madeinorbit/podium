import { asMachineId, asUserId } from '@podium/model'
import {
  asSubscriberId,
  type ServerMessage,
  SubscriptionRegistry,
  TOPIC_KEYS_PER_CONNECTION_MAX,
  topicKey,
  topicRoutingKey,
} from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { userClientPrincipal } from './client-principal'
import { type ClientConn, ClientRegistry } from './client-registry'
import { createDaemonTopicIngress } from './topic-ingress'
import { daemonTopicProducer, type TopicProducers, TopicRouting } from './topic-routing'

const M1 = asMachineId('m-1')
const M2 = asMachineId('m-2')

function fixture() {
  const subscriptions = new SubscriptionRegistry()
  const clients = new ClientRegistry()
  const watches: Array<{ machineId: string; key: string; on: boolean }> = []
  const producers: TopicProducers = {
    'machine.condition': { snapshot: () => ({ online: true, since: null }) },
    'machine.metrics': daemonTopicProducer({
      kind: 'machine.metrics',
      machineOf: (id) => asMachineId(id),
      supportsTopics: () => true,
      send: (machineId, frame) => watches.push({ machineId, key: frame.key, on: frame.on }),
    }),
    'account.events': {},
    'checkout.changed': {},
    'machine.processes': {},
  }
  const topics = new TopicRouting({
    subscriptions,
    clients,
    prepareVisibility: async () => ({ canSee: () => true }),
    producers,
    epoch: 'test',
  })
  const conn = (id: string): { conn: ClientConn; sent: ServerMessage[] } => {
    const sent: ServerMessage[] = []
    const c = {
      id,
      principal: userClientPrincipal(id, asUserId('u-1'), 'admin'),
      send: (msg: ServerMessage) => sent.push(msg),
      sendStream: (msg: ServerMessage) => {
        sent.push(msg)
        return true
      },
    } as unknown as ClientConn
    clients.add(c)
    return { conn: c, sent }
  }
  return { subscriptions, clients, topics, producers, watches, conn }
}

describe('TopicRouting', () => {
  it('answers an unknown kind with unsupported and registers nothing', async () => {
    const f = fixture()
    const { conn, sent } = f.conn('c1')
    await f.topics.route(conn, { type: 'topicSubscribe', key: 'future.kind:x' as never })
    expect(sent).toEqual([{ type: 'topicClosed', key: 'future.kind:x', reason: 'unsupported' }])
    expect(f.subscriptions.keyCount).toBe(0)
  })

  it('refuses an id its kind cannot carry, like a missing key', async () => {
    const f = fixture()
    const { conn, sent } = f.conn('c1')
    await f.topics.route(conn, {
      type: 'topicSubscribe',
      key: topicKey('machine.metrics', 'local'),
    })
    expect(sent).toEqual([
      { type: 'topicClosed', key: topicKey('machine.metrics', 'local'), reason: 'refused' },
    ])
  })

  it(`holds at most ${TOPIC_KEYS_PER_CONNECTION_MAX} keys per connection`, async () => {
    const f = fixture()
    const { conn, sent } = f.conn('c1')
    for (let i = 0; i < TOPIC_KEYS_PER_CONNECTION_MAX; i++) {
      await f.topics.route(conn, {
        type: 'topicSubscribe',
        key: topicKey('machine.condition', `m-${i}`),
      })
    }
    sent.length = 0
    const over = topicKey('machine.condition', 'm-over')
    await f.topics.route(conn, { type: 'topicSubscribe', key: over })
    expect(sent).toEqual([{ type: 'topicClosed', key: over, reason: 'refused' }])
    // A key already held is still re-snapshotted, not refused.
    await f.topics.route(conn, {
      type: 'topicSubscribe',
      key: topicKey('machine.condition', 'm-0'),
    })
    expect(sent.at(-1)).toMatchObject({
      type: 'topicSnapshot',
      key: topicKey('machine.condition', 'm-0'),
    })
  })

  it('demand follows zero-crossings only, and an internal holder counts like a client', async () => {
    const f = fixture()
    const a = f.conn('a')
    const b = f.conn('b')
    const key = topicKey('machine.metrics', M1)
    await f.topics.route(a.conn, { type: 'topicSubscribe', key })
    await f.topics.route(b.conn, { type: 'topicSubscribe', key })
    f.topics.hold('sweep', 'machine.metrics', M1)
    expect(f.watches).toEqual([{ machineId: M1, key, on: true }])
    f.topics.disconnect(a.conn)
    await f.topics.route(b.conn, { type: 'topicUnsubscribe', key })
    expect(f.watches).toHaveLength(1)
    f.topics.release('sweep', 'machine.metrics', M1)
    expect(f.watches.at(-1)).toEqual({ machineId: M1, key, on: false })
    expect(
      f.subscriptions.subscribers(topicRoutingKey({ kind: 'machine.metrics', id: M1 })),
    ).toEqual([])
  })

  it('re-sends demand on reattach for exactly the held keys of that machine', async () => {
    const f = fixture()
    const { conn } = f.conn('c1')
    await f.topics.route(conn, { type: 'topicSubscribe', key: topicKey('machine.metrics', M1) })
    await f.topics.route(conn, { type: 'topicSubscribe', key: topicKey('machine.metrics', M2) })
    f.watches.length = 0
    f.topics.machineAttached(M1)
    expect(f.watches).toEqual([{ machineId: M1, key: topicKey('machine.metrics', M1), on: true }])
  })

  it('drops publishes for a key nobody holds, and frames for internal holders never reach a socket', async () => {
    const f = fixture()
    const deliverStream = vi.spyOn(f.clients, 'deliverStream')
    f.topics.publish('machine.condition', M1, { online: false, since: null })
    f.topics.hold('sweep', 'machine.condition', M1)
    f.topics.publish('machine.condition', M1, { online: false, since: null })
    f.topics.flushNow()
    expect(deliverStream).not.toHaveBeenCalled()
  })
})

describe('daemon topic ingress', () => {
  it('refuses a key that belongs to another machine and a payload that does not match', () => {
    const f = fixture()
    const sink = vi.fn()
    const ingress = createDaemonTopicIngress({
      producers: f.producers,
      sinks: { 'machine.metrics': sink, 'checkout.changed': vi.fn(), 'machine.processes': vi.fn() },
    })
    const sample = {
      hostname: 'h',
      sampledAt: '2026-11-08T00:00:00.000Z',
      memory: { totalBytes: 2, availableBytes: 1, swapTotalBytes: 0, swapFreeBytes: 0 },
    }
    ingress.onTopicPublish(M1, {
      type: 'topicPublish',
      key: topicKey('machine.metrics', M2),
      payload: sample,
    })
    ingress.onTopicPublish(M1, {
      type: 'topicPublish',
      key: topicKey('machine.metrics', M1),
      payload: { no: 1 },
    })
    ingress.onTopicPublish(M1, {
      type: 'topicPublish',
      key: topicKey('machine.condition', M1),
      payload: { online: true, since: null },
    })
    expect(sink).not.toHaveBeenCalled()
    ingress.onTopicPublish(M1, {
      type: 'topicPublish',
      key: topicKey('machine.metrics', M1),
      payload: sample,
    })
    expect(sink).toHaveBeenCalledWith(M1, sample)
  })
})

describe('revocation', () => {
  it('closes with revoked and stops the producer when the last viewer loses sight', async () => {
    const subscriptions = new SubscriptionRegistry()
    const clients = new ClientRegistry()
    let visible = true
    const stop = vi.fn()
    const topics = new TopicRouting({
      subscriptions,
      clients,
      prepareVisibility: async () => ({ canSee: () => visible }),
      producers: {
        'machine.condition': { snapshot: () => ({ online: true, since: null }), stop },
        'machine.metrics': {},
        'account.events': {},
        'checkout.changed': {},
        'machine.processes': {},
      },
    })
    const sent: ServerMessage[] = []
    const conn = {
      id: 'c1',
      principal: userClientPrincipal('c1', asUserId('u-1'), 'admin'),
      send: (msg: ServerMessage) => sent.push(msg),
      sendStream: (msg: ServerMessage) => sent.push(msg) > 0,
    } as unknown as ClientConn
    clients.add(conn)
    const key = topicKey('machine.condition', M1)
    await topics.route(conn, { type: 'topicSubscribe', key })
    visible = false
    await topics.revalidateSubscribers([asSubscriberId('c1')])
    expect(sent.at(-1)).toEqual({ type: 'topicClosed', key, reason: 'revoked' })
    expect(stop).toHaveBeenCalledWith(M1)
    expect(subscriptions.keyCount).toBe(0)
  })
})
