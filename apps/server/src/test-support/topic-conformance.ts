/**
 * THE TOPIC CONFORMANCE HARNESS — ADR 7 Amendment 2 D25.
 *
 * One harness, every kind. It wires the REAL pieces end to end:
 *
 *   client SocketHub ─ in-memory socket ─ server TopicRouting ─ fake daemon
 *
 * The client side is the production hub and its subscription registry; the
 * server side is the production routing, the daemon producer, the daemon
 * ingress and the machine-condition producer, composed the way `relay.ts`
 * composes them. Only the daemon is a fake: it samples while it holds a
 * `topicWatch on`, and nothing else, so "no subscriber, no samples" is a
 * counted fact.
 *
 * A later kind joins by adding a {@link TopicConformanceCase} and calling
 * {@link describeTopicConformance}; `topics.test.ts` in the protocol package
 * fails until every declared kind has one (the totality test, D17).
 */

import {
  SocketHub,
  type TopicState,
  type WebSocketLike,
} from '@podium/client-core/socket-transport'
import {
  asMachineId,
  asUserId,
  type HostMetricsWire,
  type MachineId,
  type UserId,
} from '@podium/model'
import {
  asSubscriberId,
  CAP_TOPICS_V1,
  type ClientMessage,
  encode,
  parseCheckoutTopicId,
  parseTopicKey,
  type ServerMessage,
  SubscriptionRegistry,
  TOPIC_KINDS,
  type TopicKind,
  type TopicPayload,
  type TopicWatchMessage,
  topicKey,
  topicRefFromRoutingKey,
  topicRoutingKey,
  type VisibilityResolver,
} from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userClientPrincipal } from '../gateway/client-principal'
import { type ClientConn, ClientRegistry } from '../gateway/client-registry'
import { createDaemonTopicIngress } from '../gateway/topic-ingress'
import { daemonTopicProducer, type TopicProducers, TopicRouting } from '../gateway/topic-routing'
import { MachineConditionTopic } from '../modules/machines/condition-topic'
import { AccountQuotaTopic, AccountUsageTopic } from '../modules/quota-history/quota-topic'

export const MACHINE = asMachineId('m-conformance')
export const OTHER_MACHINE = asMachineId('m-other')
export const USER = asUserId('u-viewer')
export const OTHER_USER = asUserId('u-stranger')
export const SAMPLE_INTERVAL_MS = 5_000

/**
 * Let queued microtasks and zero-delay timers run, several rounds deep: a
 * server producer that reads before it publishes (account.quota's pass awaits
 * the sampler, the custodians and the usage read) schedules its frame a few
 * hops after the subscribe. No fake time passes.
 */
export const settle = async (): Promise<void> => {
  for (let round = 0; round < 8; round++) await vi.advanceTimersByTimeAsync(0)
}

export const hostSample = (n: number): HostMetricsWire => ({
  hostname: 'conformance-host',
  sampledAt: new Date(Date.now()).toISOString(),
  memory: { totalBytes: 1_000, availableBytes: 1_000 - n, swapTotalBytes: 0, swapFreeBytes: 0 },
})

// ---------------------------------------------------------------------------
// The fake daemon
// ---------------------------------------------------------------------------

/**
 * Samples only while the server holds a watch on one of its keys. A daemon
 * WITHOUT `topics.v1` (`legacy`) instead samples always, as today's daemon does,
 * and reports through the pre-topics frame.
 *
 * Its lifecycle mirrors the real daemon's (`host-runtime.ts`, ADR 7 Amendment 2
 * D22): the watches are PER LINK, so a link loss stops every topic producer at
 * once, exactly as a process exit does. The legacy always-on timer is not a
 * watch: it survives a link loss (reporting nothing while no link is up) and
 * stops only with the process.
 */
export class FakeDaemon {
  connected = false
  /** Every topicWatch the server sent, in order. */
  readonly watches: TopicWatchMessage[] = []
  /** Samples taken (topic or legacy), counted over a test's window. */
  samples = 0
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>()
  private legacyTimer: ReturnType<typeof setInterval> | undefined
  private n = 0

  constructor(
    readonly machineId: MachineId,
    private readonly report: (
      machineId: MachineId,
      sample: HostMetricsWire,
      viaTopic: boolean,
      key?: string,
    ) => void,
    readonly topics: boolean,
  ) {}

  /** The server's control frame. No frame arrives while no link is up. */
  receive(frame: TopicWatchMessage): void {
    if (!this.connected) return
    this.watches.push(frame)
    if (!frame.on) {
      const timer = this.timers.get(frame.key)
      if (timer) clearInterval(timer)
      this.timers.delete(frame.key)
      return
    }
    if (this.timers.has(frame.key)) return
    this.timers.set(
      frame.key,
      setInterval(() => this.sample(frame.key), SAMPLE_INTERVAL_MS),
    )
    // A demanded key is sampled at once, as the daemon's own sampler does.
    this.sample(frame.key)
  }

  get watching(): number {
    return this.timers.size
  }

  /** One sample now, if anything demands it (or always, on a legacy daemon). */
  sample(key?: string): void {
    if (!this.connected) return
    if (this.topics && this.timers.size === 0) return
    this.samples += 1
    const sample = hostSample(++this.n)
    if (this.topics)
      for (const held of key ? [key] : this.timers.keys())
        this.report(this.machineId, sample, true, held)
    else this.report(this.machineId, sample, false)
  }

  /** The link came up. A new link starts with NO demand (D22). */
  linkUp(): void {
    this.connected = true
    this.stopWatches()
    if (!this.topics && !this.legacyTimer)
      this.legacyTimer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS)
  }

  /** The link went down: every topic producer stops with it (D22). */
  linkDown(): void {
    this.connected = false
    this.stopWatches()
  }

  /** The process died: the link and everything it ran, the legacy timer included. */
  exit(): void {
    this.linkDown()
    if (this.legacyTimer) clearInterval(this.legacyTimer)
    this.legacyTimer = undefined
  }

  private stopWatches(): void {
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
  }
}

// ---------------------------------------------------------------------------
// The in-memory client socket
// ---------------------------------------------------------------------------

class BridgeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  open = false
  constructor(private readonly receive: (msg: ClientMessage) => void) {}
  send(data: string | Uint8Array): void {
    if (this.open && typeof data === 'string') this.receive(JSON.parse(data) as ClientMessage)
  }
  close(): void {
    if (!this.open) return
    this.open = false
    this.onclose?.({})
  }
  /** Asynchronous, as a network is: a reply never lands inside the sender's turn. */
  deliver(msg: ServerMessage): void {
    const data = encode(msg)
    queueMicrotask(() => {
      if (this.open) this.onmessage?.({ data })
    })
  }
}

/** One client runtime: a production SocketHub over an in-memory socket. */
export interface ConformanceClient {
  readonly hub: SocketHub
  readonly user: UserId
  /** The server connection behind the CURRENT socket. */
  conn(): ClientConn | undefined
  /** Server frames this client received, all sockets, in order. */
  readonly received: ServerMessage[]
  /** `Date.now()` at each entry of {@link received}. */
  readonly receivedAt: number[]
  /** Kill the socket from the server side (a network drop). */
  drop(): void
  /** Refuse (or allow again) stream sends to this client, as a full socket would. */
  setPressure(on: boolean): void
  /** Frames of one type for one key. */
  frames(type: ServerMessage['type'], key?: string): ServerMessage[]
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface TopicWorld {
  readonly subscriptions: SubscriptionRegistry
  readonly clients: ClientRegistry
  readonly topics: TopicRouting
  readonly daemon: FakeDaemon
  /** Producer start/stop calls per kind, for the lifecycle case. */
  readonly lifecycle: Record<TopicKind, { start: number; stop: number }>
  /** Who may see which machine: `${user}:${machineId}`. */
  readonly visible: Set<string>
  /** Newest metrics per machine, as the hosts service keeps them. */
  readonly latestMetrics: Map<MachineId, HostMetricsWire>
  /** Pre-topics `hostMetricsChanged` broadcasts sent to clients without topics. */
  legacyBroadcasts: number
  /**
   * The `account.quota` producer over a fake sampler (POD-5798): `quota.samples`
   * counts fan-outs to the daemons, `quota.produce()` changes the reading and
   * runs one live pass.
   */
  readonly quota: {
    readonly topic: AccountQuotaTopic
    readonly samples: number
    produce(): Promise<void>
  }
  /** The `account.usage` producer: `usage.harvests` counts transcript reads. */
  readonly usage: {
    readonly topic: AccountUsageTopic
    readonly harvests: number
    produce(): Promise<void>
  }
  client(user?: UserId): Promise<ConformanceClient>
  attachDaemon(): Promise<void>
  /** The daemon's server link drops; the process lives on. */
  detachDaemon(): Promise<void>
  /** The daemon process restarts: link down, a new process, link up. */
  restartDaemon(): Promise<void>
  /** Re-check visibility for every connection, as a feed rescope does. */
  revalidate(): Promise<void>
  dispose(): void
}

export async function createTopicWorld(
  options: { daemonTopics?: boolean } = {},
): Promise<TopicWorld> {
  const subscriptions = new SubscriptionRegistry()
  const clients = new ClientRegistry()
  const visible = new Set<string>([`${USER}:${MACHINE}`])
  const latestMetrics = new Map<MachineId, HostMetricsWire>()
  const lifecycle = Object.fromEntries(
    Object.keys(TOPIC_KINDS).map((kind) => [kind, { start: 0, stop: 0 }]),
  ) as Record<TopicKind, { start: number; stop: number }>
  const hubs: SocketHub[] = []
  let legacyBroadcasts = 0

  // Late-bound exactly as relay.ts does: the producers close over the routing.
  let topics!: TopicRouting
  let daemon!: FakeDaemon

  const conditions = new MachineConditionTopic({
    condition: (machineId) => ({ online: machineId === daemon.machineId && daemon.connected }),
    now: () => Date.now(),
    publish: (machineId, value) => topics.publish('machine.condition', machineId, value),
  })
  const metrics = daemonTopicProducer({
    kind: 'machine.metrics',
    machineOf: (id) => asMachineId(id),
    supportsTopics: (machineId) =>
      machineId === daemon.machineId && daemon.connected && daemon.topics,
    send: (machineId, frame) => {
      if (machineId === daemon.machineId && daemon.connected) daemon.receive(frame)
    },
    snapshot: (id) => latestMetrics.get(asMachineId(id)),
  })
  const counted = (
    kind: TopicKind,
    producer: TopicProducers[TopicKind],
  ): TopicProducers[TopicKind] => ({
    ...producer,
    start: (id) => {
      lifecycle[kind].start += 1
      producer.start?.(id)
    },
    stop: (id) => {
      lifecycle[kind].stop += 1
      producer.stop?.(id)
    },
  })
  const latestProcesses = new Map<
    string,
    import('@podium/protocol').TopicPayload<'machine.processes'>
  >()
  const extra = (kind: 'checkout.changed' | 'machine.processes') =>
    daemonTopicProducer({
      kind,
      machineOf: (id) =>
        kind === 'checkout.changed' ? parseCheckoutTopicId(id)?.machineId : asMachineId(id),
      supportsTopics: () => daemon.connected && daemon.topics,
      send: (_machine, frame) => daemon.receive(frame),
      snapshot: (id) => (kind === 'checkout.changed' ? null : latestProcesses.get(id)),
    })
  // `account.quota` over a fake sampler: MACHINE is in USER's custody, and
  // every reading names a new percentage so each pass is a new value.
  let quotaReading = 0
  let quotaSamples = 0
  const quotaTopic = new AccountQuotaTopic({
    sample: async () => {
      quotaSamples += 1
      return [
        {
          machineId: MACHINE,
          machineName: 'conformance',
          hostname: 'conformance.local',
          agents: [
            {
              agent: 'claude-code',
              status: 'ok',
              windows: [
                {
                  key: 'five_hour',
                  label: '5h',
                  usedPercent: quotaReading,
                  resetsAt: '2026-11-08T15:00:00.000Z',
                  windowMinutes: 300,
                },
              ],
              fetchedAt: '2026-11-08T12:00:00.000Z',
            },
          ],
        },
      ]
    },
    custodian: async (machineId) => (machineId === MACHINE ? USER : null),
    publish: (user, value) => topics.publish('account.quota', user, value),
  })
  // `account.usage` over a fake harvest: each read names a new scan time.
  let usageReading = 0
  let usageHarvests = 0
  const usageTopic = new AccountUsageTopic({
    readUsage: async () => {
      usageHarvests += 1
      return {
        hostname: 'conformance.local',
        sampledAt: new Date(
          Date.parse('2026-11-08T12:00:00.000Z') + usageReading * 1000,
        ).toISOString(),
        buckets: [],
      }
    },
    publish: (user, value) => topics.publish('account.usage', user, value),
  })
  const producers: TopicProducers = {
    'machine.condition': counted('machine.condition', {
      snapshot: (id) => conditions.snapshot(asMachineId(id)),
    }),
    'machine.metrics': counted('machine.metrics', metrics),
    'checkout.changed': counted('checkout.changed', extra('checkout.changed')),
    'machine.processes': counted('machine.processes', extra('machine.processes')),
    'account.quota': counted('account.quota', {
      start: (id) => quotaTopic.start(asUserId(id)),
      stop: (id) => quotaTopic.stop(asUserId(id)),
      snapshot: (id) => quotaTopic.snapshot(asUserId(id)),
    }),
    'account.usage': counted('account.usage', {
      start: (id) => usageTopic.start(asUserId(id)),
      stop: (id) => usageTopic.stop(asUserId(id)),
      snapshot: (id) => usageTopic.snapshot(asUserId(id)),
    }),
    'account.events': counted('account.events', {}),
  }
  topics = new TopicRouting({
    subscriptions,
    clients,
    prepareVisibility: async (): Promise<VisibilityResolver> => ({
      canSee: (principal, entity) =>
        principal.kind === 'user' && visible.has(`${principal.user}:${entity.id}`),
    }),
    prepareMachineUse: async () => ({
      canSee: (principal, entity) =>
        principal.kind === 'user' && visible.has(`${principal.user}:${entity.id}`),
    }),
    producers,
    epoch: 'conformance',
  })

  // As relay.ts binds it: an account notice goes on the topic when held.
  clients.routeAccountEvents(
    (conn, msg) =>
      topics.emit('account.events', conn.principal.user, msg, (id) => String(id) === conn.id).size >
      0,
  )

  // The hosts service's role in the chain: keep the newest sample, hand it on.
  const installMetrics = (machineId: MachineId, sample: HostMetricsWire | undefined): void => {
    if (sample) latestMetrics.set(machineId, sample)
    else latestMetrics.delete(machineId)
    topics.publish('machine.metrics', machineId, sample)
    for (const conn of clients.values()) {
      if (!conn.caps.has(CAP_TOPICS_V1)) {
        legacyBroadcasts += 1
        conn.send({ type: 'hostMetricsChanged', hosts: [...latestMetrics.values()] })
      }
    }
  }
  const ingress = createDaemonTopicIngress({
    producers,
    sinks: {
      'checkout.changed': (_machine, payload, id) =>
        topics.publish('checkout.changed', id, payload),
      'machine.processes': (_machine, payload, id) => {
        const value = { breakdown: payload as import('@podium/protocol').HostMemoryBreakdown }
        latestProcesses.set(id, value)
        topics.publish('machine.processes', id, value)
      },
      'machine.metrics': (machineId, payload) =>
        installMetrics(machineId, { ...(payload as HostMetricsWire), machineId }),
    },
  })
  daemon = new FakeDaemon(
    MACHINE,
    (machineId, sample, viaTopic, key) => {
      if (viaTopic) {
        ingress.onTopicPublish(machineId, {
          type: 'topicPublish',
          key: key as import('@podium/protocol').TopicKey,
          payload:
            parseTopicKey(key ?? '')?.kind === 'checkout.changed'
              ? null
              : parseTopicKey(key ?? '')?.kind === 'machine.processes'
                ? { ...sample, supported: true, agents: [], projects: [], otherBytes: 0 }
                : sample,
        })
      } else {
        // The pre-topics `hostMetrics` frame: the same sink, the old envelope.
        installMetrics(machineId, { ...sample, machineId })
      }
    },
    options.daemonTopics ?? true,
  )

  const world: TopicWorld = {
    subscriptions,
    clients,
    topics,
    daemon,
    lifecycle,
    visible,
    latestMetrics,
    quota: {
      topic: quotaTopic,
      get samples() {
        return quotaSamples
      },
      async produce() {
        quotaReading += 1
        await quotaTopic.pass()
      },
    },
    usage: {
      topic: usageTopic,
      get harvests() {
        return usageHarvests
      },
      async produce() {
        usageReading += 1
        await usageTopic.pass()
      },
    },
    get legacyBroadcasts() {
      return legacyBroadcasts
    },
    set legacyBroadcasts(value: number) {
      legacyBroadcasts = value
    },
    async client(user = USER) {
      const received: ServerMessage[] = []
      const receivedAt: number[] = []
      let current: { socket: BridgeSocket; conn: ClientConn } | undefined
      let pressure = false
      const makeSocket = (): WebSocketLike => {
        const id = clients.nextId()
        let socket!: BridgeSocket
        const conn: ClientConn = {
          id,
          principal: userClientPrincipal(id, user, 'admin'),
          send: (msg) => {
            received.push(msg)
            receivedAt.push(Date.now())
            socket.deliver(msg)
          },
          sendStream: (msg) => {
            if (pressure) return false
            received.push(msg)
            receivedAt.push(Date.now())
            socket.deliver(msg)
            return true
          },
          viewports: new Map(),
          attached: new Set(),
          caps: new Set(),
          wireVersion: 1,
          transcriptSubs: new Set(),
          visible: false,
          viewVisible: new Set(),
          focused: null,
          viewModes: {},
        }
        socket = new BridgeSocket((msg) => {
          if (msg.type === 'hello') {
            conn.caps = new Set(msg.caps ?? [])
            conn.send({
              type: 'welcome',
              clientId: id,
              caps: conn.caps.has(CAP_TOPICS_V1) ? [CAP_TOPICS_V1] : [],
              ...(conn.caps.has(CAP_TOPICS_V1) ? { accountUser: user } : {}),
            })
            return
          }
          if (msg.type === 'ping') {
            conn.send({ type: 'pong' })
            return
          }
          if (msg.type === 'topicSubscribe' || msg.type === 'topicUnsubscribe') {
            void topics.route(conn, msg)
          }
        })
        const origClose = socket.close.bind(socket)
        socket.close = () => {
          if (clients.get(id) === conn) {
            // The mux's order: topics first, then the registry entry.
            topics.disconnect(conn)
            clients.delete(id)
          }
          origClose()
        }
        current = { socket, conn }
        // The server accepts on the next turn, like a real upgrade.
        setTimeout(() => {
          clients.add(conn)
          socket.open = true
          socket.onopen?.({})
        }, 0)
        return socket
      }
      const hub = new SocketHub({ url: 'ws://conformance', makeSocket })
      hubs.push(hub)
      hub.connect()
      await settle()
      return {
        hub,
        user,
        conn: () => current?.conn,
        received,
        receivedAt,
        drop: () => current?.socket.close(),
        setPressure: (on) => {
          pressure = on
        },
        frames: (type, key) =>
          received.filter(
            (msg) => msg.type === type && (key === undefined || ('key' in msg && msg.key === key)),
          ),
      }
    },
    async attachDaemon() {
      daemon.linkUp()
      conditions.changed(daemon.machineId)
      topics.machineAttached(daemon.machineId)
      await settle()
    },
    async detachDaemon() {
      daemon.linkDown()
      installMetrics(daemon.machineId, undefined)
      conditions.changed(daemon.machineId)
      await settle()
    },
    async restartDaemon() {
      await world.detachDaemon()
      daemon.exit()
      await world.attachDaemon()
    },
    async revalidate() {
      await topics.revalidateSubscribers(
        [...clients.values()].map((conn) => asSubscriberId(conn.id)),
      )
      await settle()
    },
    dispose() {
      for (const hub of hubs) hub.dispose()
      quotaTopic.dispose()
      usageTopic.dispose()
      daemon.exit()
    },
  }
  return world
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export interface TopicConformanceCase<K extends TopicKind> {
  readonly kind: K
  /** An id the conformance viewer may see. */
  readonly id: string
  /** An id nobody in the world may see (or that does not exist). */
  readonly hiddenId: string
  /** Make the producer emit a new value. Resolves once it has been handed on. */
  produce(world: TopicWorld): Promise<void>
  /** A value-kind payload the client should hold after `produce` (for ordering checks). */
  readonly describeValue: (value: TopicPayload<K>) => string
  /** Bring the world to "the producer can produce" (attach the daemon, …). */
  prepare(world: TopicWorld): Promise<void>
  /** Can this kind's visibility be revoked by the world's grant set? */
  readonly revocable: boolean
}

/** Hold a key on a client and record every state the listener hears. */
export function holdTopic<K extends TopicKind>(
  client: ConformanceClient,
  kind: K,
  id: string,
): { states: TopicState<TopicPayload<K>>[]; release: () => void } {
  const states: TopicState<TopicPayload<K>>[] = []
  const release = client.hub.subscribeTopic(kind, id, { onState: (state) => states.push(state) })
  return { states, release }
}

const serverHolds = (world: TopicWorld, kind: TopicKind, id: string): number =>
  world.subscriptions.subscribers(topicRoutingKey({ kind, id })).length

/** The D25 cases, for one value kind. */
export function describeTopicConformance<K extends TopicKind>(c: TopicConformanceCase<K>): void {
  const decl = TOPIC_KINDS[c.kind]
  const key = topicKey(c.kind, c.id)

  describe(`topic conformance: ${c.kind}`, () => {
    let world: TopicWorld
    beforeEach(async () => {
      vi.useFakeTimers()
      world = await createTopicWorld()
      await c.prepare(world)
    })
    afterEach(() => {
      world.dispose()
      vi.useRealTimers()
    })

    it('1. subscribe gives a snapshot first, then updates in order', async () => {
      const client = await world.client()
      const held = holdTopic(client, c.kind, c.id)
      await settle()
      const frames = client.received.filter((m) => 'key' in m && m.key === key)
      expect(frames[0]?.type).toBe('topicSnapshot')
      expect(held.states.at(-1)?.status).toBe('value')
      const seqs: number[] = []
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(decl.minIntervalMs)
        await c.produce(world)
        await vi.advanceTimersByTimeAsync(decl.minIntervalMs)
      }
      for (const frame of client.frames('topicUpdate', key)) {
        if (frame.type === 'topicUpdate') seqs.push(frame.position.seq)
      }
      expect(seqs.length).toBeGreaterThanOrEqual(3)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(held.states.at(-1)?.status).toBe('value')
    })

    it('2. two holders in one runtime make ONE server subscription; the last release unsubscribes', async () => {
      const client = await world.client()
      const a = holdTopic(client, c.kind, c.id)
      const b = holdTopic(client, c.kind, c.id)
      await settle()
      expect(serverHolds(world, c.kind, c.id)).toBe(1)
      expect(client.frames('topicSnapshot', key)).toHaveLength(1)
      // The second holder heard the shared state at once.
      expect(b.states.at(-1)?.status).toBe('value')
      a.release()
      await settle()
      expect(serverHolds(world, c.kind, c.id)).toBe(1)
      b.release()
      await settle()
      expect(serverHolds(world, c.kind, c.id)).toBe(0)
    })

    it('3. with no subscriber the producer is stopped and nothing is published for a full interval', async () => {
      const client = await world.client()
      const held = holdTopic(client, c.kind, c.id)
      await settle()
      held.release()
      await settle()
      const before = client.received.length
      const samplesBefore = world.daemon.samples
      await vi.advanceTimersByTimeAsync(Math.max(decl.minIntervalMs, SAMPLE_INTERVAL_MS) * 2)
      await c.produce(world)
      await settle()
      expect(client.received.slice(before).filter((m) => 'key' in m && m.key === key)).toEqual([])
      if (decl.producer === 'daemon') {
        expect(world.daemon.watches.at(-1)).toEqual({ type: 'topicWatch', key, on: false })
        expect(world.daemon.samples).toBe(samplesBefore)
        expect(world.daemon.watching).toBe(0)
      }
    })

    it('4. disconnect then reconnect: the value goes unknown, then a fresh snapshot', async () => {
      const client = await world.client()
      const held = holdTopic(client, c.kind, c.id)
      await settle()
      expect(held.states.at(-1)?.status).toBe('value')
      client.drop()
      await settle()
      const lost = held.states.at(-1)
      expect(lost?.status).toBe('unknown')
      // The last value survives for "last seen".
      expect(lost?.status === 'unknown' && lost.last !== undefined).toBe(true)
      // The hub's backoff, then a new socket and the resubscribe.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(client.frames('topicSnapshot', key)).toHaveLength(2)
      expect(held.states.at(-1)?.status).toBe('value')
      expect(serverHolds(world, c.kind, c.id)).toBe(1)
    })

    if (decl.producer === 'daemon') {
      it('5. a daemon restart with subscribers re-sends topicWatch on, and updates resume', async () => {
        const client = await world.client()
        holdTopic(client, c.kind, c.id)
        await settle()
        const updatesBefore = client.frames('topicUpdate', key).length
        await world.restartDaemon()
        expect(world.daemon.watches.at(-1)).toEqual({ type: 'topicWatch', key, on: true })
        expect(world.daemon.watching).toBe(1)
        await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 2)
        expect(client.frames('topicUpdate', key).length).toBeGreaterThan(updatesBefore)
      })

      it('5b. a viewer that leaves while the daemon link is down leaves its producer stopped after reconnect', async () => {
        const client = await world.client()
        const held = holdTopic(client, c.kind, c.id)
        await settle()
        expect(world.daemon.watching).toBe(1)
        // The link drops: the daemon stops every producer at once (D22) …
        await world.detachDaemon()
        expect(world.daemon.watching).toBe(0)
        // … and the last viewer leaves during the outage. The `off` cannot reach it.
        held.release()
        await settle()
        expect(serverHolds(world, c.kind, c.id)).toBe(0)
        const watchesBefore = world.daemon.watches.length
        await world.attachDaemon()
        const samplesBefore = world.daemon.samples
        await vi.advanceTimersByTimeAsync(Math.max(decl.minIntervalMs, SAMPLE_INTERVAL_MS) * 3)
        // The reattach re-demands nothing for it (D21), so nothing runs or samples.
        expect(world.daemon.watches.slice(watchesBefore)).toEqual([])
        expect(world.daemon.watching).toBe(0)
        expect(world.daemon.samples).toBe(samplesBefore)
        expect(world.lifecycle[c.kind].stop).toBe(1)
      })
    }

    it('8. a refused subscribe looks like a missing key; revoking visibility closes with revoked and evicts', async () => {
      const client = await world.client()
      const hidden = holdTopic(client, c.kind, c.hiddenId)
      await settle()
      expect(client.frames('topicClosed', topicKey(c.kind, c.hiddenId))).toEqual([
        { type: 'topicClosed', key: topicKey(c.kind, c.hiddenId), reason: 'refused' },
      ])
      expect(hidden.states.at(-1)).toMatchObject({ status: 'closed', reason: 'refused' })
      expect(serverHolds(world, c.kind, c.hiddenId)).toBe(0)
      if (!c.revocable) return
      const held = holdTopic(client, c.kind, c.id)
      await settle()
      expect(serverHolds(world, c.kind, c.id)).toBe(1)
      world.visible.clear()
      await world.revalidate()
      expect(client.frames('topicClosed', key)).toEqual([
        { type: 'topicClosed', key, reason: 'revoked' },
      ])
      expect(held.states.at(-1)).toMatchObject({ status: 'closed', reason: 'revoked' })
      expect(serverHolds(world, c.kind, c.id)).toBe(0)
      expect(world.lifecycle[c.kind].stop).toBeGreaterThanOrEqual(1)
    })

    it('9. a value the socket refused is re-sent as the newest snapshot, never left stale', async () => {
      const client = await world.client()
      const held = holdTopic(client, c.kind, c.id)
      await settle()
      client.setPressure(true)
      await vi.advanceTimersByTimeAsync(decl.minIntervalMs)
      await c.produce(world)
      await vi.advanceTimersByTimeAsync(decl.minIntervalMs)
      const heardUnderPressure = held.states.length
      client.setPressure(false)
      await vi.advanceTimersByTimeAsync(1_000)
      // The refused value came back as a fresh snapshot once the socket drained.
      expect(held.states.length).toBeGreaterThan(heardUnderPressure)
      expect(held.states.at(-1)?.status).toBe('value')
    })

    it('10. the server never sends faster than the declared rate', async () => {
      const client = await world.client()
      holdTopic(client, c.kind, c.id)
      await settle()
      for (let i = 0; i < 8; i++) {
        await c.produce(world)
        await vi.advanceTimersByTimeAsync(Math.floor(decl.minIntervalMs / 4))
      }
      await vi.advanceTimersByTimeAsync(decl.minIntervalMs * 2)
      const at = client.received.flatMap((msg, index) =>
        msg.type === 'topicUpdate' && msg.key === key ? [client.receivedAt[index]!] : [],
      )
      expect(at.length).toBeGreaterThan(1)
      for (let i = 1; i < at.length; i++) {
        expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(decl.minIntervalMs)
      }
    })

    it('11. start runs once on the first subscriber and stop on the last, across a reconnect storm', async () => {
      const a = await world.client()
      const b = await world.client()
      holdTopic(a, c.kind, c.id)
      const heldB = holdTopic(b, c.kind, c.id)
      await settle()
      const life = world.lifecycle[c.kind]
      expect(life.start).toBe(1)
      for (let i = 0; i < 5; i++) {
        a.drop()
        await vi.advanceTimersByTimeAsync(20_000)
      }
      expect(life.start).toBe(1)
      expect(life.stop).toBe(0)
      heldB.release()
      a.hub.dispose()
      await settle()
      expect(serverHolds(world, c.kind, c.id)).toBe(0)
      expect(life.stop).toBe(1)
      if (decl.producer === 'daemon') expect(world.daemon.watching).toBe(0)
    })
  })
}

/** Kinds with a conformance run. The protocol totality test reads its mirror. */
export const CONFORMANCE_KINDS = new Set<TopicKind>()

export function registerConformance(kind: TopicKind): void {
  CONFORMANCE_KINDS.add(kind)
}

/** Refs a world's registry holds, for the "no second map" style checks. */
export const heldTopicKeys = (world: TopicWorld): string[] =>
  world.subscriptions.keys().filter((key) => topicRefFromRoutingKey(key) !== undefined)

export { OTHER_MACHINE as HIDDEN_MACHINE, OTHER_USER as STRANGER }
