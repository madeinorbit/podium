/**
 * TOPICS ON THE GATEWAY'S ONE SUBSCRIPTION REGISTRY — ADR 7 Amendment 2 (D21, D24).
 *
 * The same registry presence rooms use (`presence-routing.ts`), in its own key
 * namespace (`topic:kind:id`). This module adds no subscriber table of its own:
 * who holds a key is the registry's answer, every time it is asked. What it keeps
 * per HELD key is the position it assigns and the rate state, and both go when
 * the key's last subscriber leaves.
 *
 * The rules, once for every kind:
 * - subscribe runs the kind's visibility resolver (default closed; a refusal and
 *   a missing key answer the same `refused`), registers the key, and replies with
 *   a snapshot;
 * - the kind's producer is started when the key's subscriber count goes 0→1 and
 *   stopped when it goes 1→0, whoever caused it: an unsubscribe, a socket close,
 *   a revocation, an overflow close or an internal holder's release;
 * - a daemon producer's start and stop are `topicWatch on|off` to the owning
 *   machine, and every held key is re-demanded when that machine reattaches;
 * - updates are rate-limited per key (newest wins in between) and fan out through
 *   a bounded, key-coalescing stream queue onto the lossy socket sink. A value the
 *   socket could not take is re-sent as a fresh snapshot, never left stale.
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '@podium/logger'
import type { MachineId } from '@podium/model'
import {
  asSubscriberId,
  isTopicKind,
  PlaneRouter,
  type Principal,
  parseTopicKey,
  type RoutingKey,
  type SubscriberId,
  type SubscriptionRegistry,
  streamLiveDelivery,
  TOPIC_KEYS_PER_CONNECTION_MAX,
  TOPIC_KINDS,
  type TopicClientMessage,
  type TopicClosedReason,
  type TopicKey,
  type TopicKind,
  type TopicRef,
  type TopicServerMessage,
  topicKey,
  topicRefFromRoutingKey,
  topicRoutingKey,
  type VisibilityResolver,
} from '@podium/protocol'
import type { ClientConn, ClientRegistry } from './client-registry'

const log = createLogger('gateway:topics')

/** Consecutive refused socket sends on one key before it is closed with `overflow`. */
export const TOPIC_RESEND_LIMIT = 20
/** Delay before a value the socket refused is re-sent as a snapshot. */
export const TOPIC_RESEND_DELAY_MS = 250

/**
 * One kind's producer (D21). Server kinds act in process; daemon kinds are built
 * with {@link daemonTopicProducer}. Every method is optional: a kind with no
 * lifecycle (machine condition) only answers snapshots.
 */
export interface TopicProducer {
  /** The key's subscriber count went 0→1, or its machine reattached while held. */
  start?(id: string): void
  /** The key's subscriber count went 1→0. */
  stop?(id: string): void
  /** The current value, for a snapshot. Undefined is the valid snapshot `unknown`. */
  snapshot?(id: string): unknown
  /** Daemon kinds: the machine that produces this id, for re-demand on reattach. */
  machineOf?(id: string): MachineId | undefined
}

export type TopicProducers = { readonly [K in TopicKind]: TopicProducer }

/** The clock seam: tests drive rate and resend timers deterministically. */
export interface TopicTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: TopicTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface TopicRoutingDeps {
  readonly subscriptions: SubscriptionRegistry
  readonly clients: Pick<ClientRegistry, 'get' | 'deliver' | 'deliverStream'>
  /**
   * The kernel's visibility, prepared for a batch of entities (ADR 9). Only the
   * `machine` resolver needs it; `account.self` is decided from the principal.
   */
  readonly prepareVisibility: (
    entities: readonly { readonly kind: string; readonly id: string }[],
  ) => Promise<VisibilityResolver>
  readonly producers: TopicProducers
  readonly now?: () => number
  readonly timers?: TopicTimers
  /** This process's epoch base. A restarted server always starts new epochs. */
  readonly epoch?: string
}

/** Per HELD key: the position this server assigns and the rate state. */
interface KeyState {
  readonly ref: TopicRef & { readonly kind: TopicKind }
  readonly key: TopicKey
  readonly epoch: string
  seq: number
  lastSentAt?: number
  /** A coalesced update waiting for the rate interval to end. */
  pending?: { readonly payload: unknown }
  timer?: unknown
}

/** Internal (server-side) holders are registry subscribers with this id prefix. */
const INTERNAL_PREFIX = 'server:'
export const internalTopicSubscriberId = (holder: string): SubscriberId =>
  asSubscriberId(INTERNAL_PREFIX + holder)
const isInternal = (id: SubscriberId): boolean => String(id).startsWith(INTERNAL_PREFIX)

const pairKey = (subscriberId: SubscriberId, key: RoutingKey): string =>
  `${String(subscriberId)}\n${key}`

/** The update a router queue holds. Snapshots never queue: they go straight out. */
type QueuedTopicFrame = Extract<TopicServerMessage, { type: 'topicUpdate' }>

export class TopicRouting {
  private readonly router: PlaneRouter<QueuedTopicFrame>
  private readonly now: () => number
  private readonly timers: TopicTimers
  private readonly epochBase: string
  private generation = 0
  private readonly states = new Map<RoutingKey, KeyState>()
  /** (subscriber, key) pairs whose last value the socket refused, with the streak. */
  private readonly resendStreak = new Map<string, number>()
  private resendTimer: unknown
  private flushScheduled = false

  constructor(private readonly deps: TopicRoutingDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.timers = deps.timers ?? realTimers
    this.epochBase = deps.epoch ?? randomUUID()
    // Values coalesce BY KEY, so one connection's queue can never hold more than
    // one frame per held key: sized to the per-connection key cap, it does not
    // overflow, and the socket's own budget is the pressure that remains.
    this.router = new PlaneRouter(
      deps.subscriptions,
      streamLiveDelivery<QueuedTopicFrame>(TOPIC_KEYS_PER_CONNECTION_MAX, (frame) => frame.key, 1),
    )
  }

  // -------------------------------------------------------------------------
  // Client frames
  // -------------------------------------------------------------------------

  async route(conn: ClientConn, frame: TopicClientMessage): Promise<void> {
    switch (frame.type) {
      case 'topicSubscribe':
        await this.subscribe(conn, frame.key)
        return
      case 'topicUnsubscribe': {
        const ref = parseTopicKey(frame.key)
        if (ref) this.remove(topicRoutingKey(ref), asSubscriberId(conn.id))
        return
      }
      default:
        frame satisfies never
    }
  }

  private async subscribe(conn: ClientConn, key: TopicKey): Promise<void> {
    const ref = parseTopicKey(key)
    if (!ref || !isTopicKind(ref.kind)) {
      this.close(conn, key, 'unsupported')
      return
    }
    const kind = ref.kind
    if (!TOPIC_KINDS[kind].id.safeParse(ref.id).success) {
      this.close(conn, key, 'refused')
      return
    }
    const routingKey = topicRoutingKey(ref)
    const subscriberId = asSubscriberId(conn.id)
    const held = this.deps.subscriptions.has(routingKey, subscriberId)
    if (!held && this.topicKeyCount(subscriberId) >= TOPIC_KEYS_PER_CONNECTION_MAX) {
      this.close(conn, key, 'refused')
      return
    }
    const visible = await this.visibleTo(conn.principal, [{ kind, id: ref.id }])
    // The read may outlive the socket. Never resurrect a disconnected subscriber.
    if (this.deps.clients.get(conn.id) !== conn) return
    if (!visible[0]) {
      if (held) this.remove(routingKey, subscriberId)
      this.close(conn, key, 'refused')
      return
    }
    this.add({ kind, id: ref.id }, subscriberId, conn.principal)
    // A repeated subscribe is the client's resubscribe: it always gets a fresh snapshot.
    this.sendSnapshot(subscriberId, routingKey)
  }

  /** The socket closed. Runs BEFORE presence's disconnect, which forgets every registry key. */
  disconnect(conn: ClientConn): void {
    const subscriberId = asSubscriberId(conn.id)
    for (const key of this.deps.subscriptions.keysOf(subscriberId)) {
      if (topicRefFromRoutingKey(key)) this.remove(key, subscriberId)
    }
    this.router.discard(subscriberId)
    for (const pair of [...this.resendStreak.keys()]) {
      if (pair.startsWith(`${String(subscriberId)}\n`)) this.resendStreak.delete(pair)
    }
  }

  /**
   * Re-check every topic key these subscribers hold (D24): called on the same
   * trigger that rescopes their sync feed. A key they may no longer see is closed
   * with `revoked` and released.
   */
  async revalidateSubscribers(subscriberIds: readonly SubscriberId[]): Promise<void> {
    const candidates = subscriberIds.flatMap((subscriberId) => {
      const conn = this.deps.clients.get(String(subscriberId))
      if (!conn) return []
      return this.deps.subscriptions.keysOf(subscriberId).flatMap((key) => {
        const ref = topicRefFromRoutingKey(key)
        return ref && isTopicKind(ref.kind)
          ? [{ conn, subscriberId, key, ref: { kind: ref.kind, id: ref.id } }]
          : []
      })
    })
    if (candidates.length === 0) return
    const visible = await this.visibleTo(
      undefined,
      candidates.map(({ ref }) => ref),
      candidates.map(({ conn }) => conn.principal),
    )
    candidates.forEach(({ conn, subscriberId, key, ref }, index) => {
      if (this.deps.clients.get(conn.id) !== conn) return
      if (!this.deps.subscriptions.has(key, subscriberId)) return
      if (visible[index]) return
      this.remove(key, subscriberId)
      this.close(conn, topicKey(ref.kind, ref.id), 'revoked')
    })
  }

  // -------------------------------------------------------------------------
  // Server-side holders (D21: a server consumer is a subscriber like any other)
  // -------------------------------------------------------------------------

  /**
   * A named server-side subscriber, on the same registry, so it counts toward
   * demand and shows in the registry like any client. Frames routed to it are
   * discarded: an internal holder reads its producer directly.
   */
  hold(holder: string, kind: TopicKind, id: string): void {
    this.add({ kind, id }, internalTopicSubscriberId(holder), { kind: 'system', job: holder })
  }

  release(holder: string, kind: TopicKind, id: string): void {
    this.remove(topicRoutingKey({ kind, id }), internalTopicSubscriberId(holder))
  }

  // -------------------------------------------------------------------------
  // Producers
  // -------------------------------------------------------------------------

  /** True while anyone, internal or client, holds the key. */
  isHeld(kind: TopicKind, id: string): boolean {
    return this.states.has(topicRoutingKey({ kind, id }))
  }

  /**
   * A value kind's newest value (undefined: `unknown`). Dropped when nobody
   * holds the key; rate-limited and coalesced per the kind's declaration.
   */
  publish(kind: TopicKind, id: string, payload: unknown): void {
    const state = this.states.get(topicRoutingKey({ kind, id }))
    if (!state) return
    // While a coalesced update waits for its interval, a newer value only
    // replaces it: the timer is the one send, even when this publish lands
    // exactly as the interval ends (two sends in one instant otherwise).
    if (state.timer !== undefined) {
      state.pending = { payload }
      return
    }
    const minInterval = TOPIC_KINDS[kind].minIntervalMs
    const now = this.now()
    if (minInterval > 0 && state.lastSentAt !== undefined && now - state.lastSentAt < minInterval) {
      state.pending = { payload }
      state.timer = this.timers.setTimeout(
        () => this.releasePending(state),
        state.lastSentAt + minInterval - now,
      )
      return
    }
    this.sendUpdate(state, payload)
  }

  /**
   * An event kind's notice, to the key's subscribers that `to` admits (all when
   * absent). Returns the connections it was handed to, so a caller can fall back
   * to the pre-topics frame for everyone else.
   */
  emit(
    kind: TopicKind,
    id: string,
    payload: unknown,
    to?: (subscriberId: SubscriberId) => boolean,
  ): ReadonlySet<SubscriberId> {
    const key = topicKey(kind, id)
    const reached = new Set<SubscriberId>()
    for (const sub of this.deps.subscriptions.subscribers(topicRoutingKey({ kind, id }))) {
      if (isInternal(sub.subscriberId)) continue
      if (to && !to(sub.subscriberId)) continue
      // Events take the lossy stream sink directly: there is nothing to coalesce,
      // and a notice the socket cannot take now is one D19 allows to be lost.
      this.deps.clients.deliverStream(String(sub.subscriberId), {
        type: 'topicEvent',
        key,
        payload,
      })
      reached.add(sub.subscriberId)
    }
    return reached
  }

  /** Does this connection hold this key? (Event callers choose topic vs old frame.) */
  holds(conn: ClientConn, kind: TopicKind, id: string): boolean {
    return this.deps.subscriptions.has(topicRoutingKey({ kind, id }), asSubscriberId(conn.id))
  }

  /**
   * The machine reattached: re-send demand for every key of it still held (D21,
   * the generic `resetWatchLevel`). The old process's demand is forgotten with
   * it; this is the only state the new one needs.
   */
  machineAttached(machineId: MachineId): void {
    for (const key of this.deps.subscriptions.keys()) {
      const ref = topicRefFromRoutingKey(key)
      if (!ref || !isTopicKind(ref.kind) || TOPIC_KINDS[ref.kind].producer !== 'daemon') continue
      const producer = this.deps.producers[ref.kind]
      if (producer.machineOf?.(ref.id) === machineId) producer.start?.(ref.id)
    }
  }

  // -------------------------------------------------------------------------
  // Mechanism
  // -------------------------------------------------------------------------

  private add(
    ref: TopicRef & { readonly kind: TopicKind },
    subscriberId: SubscriberId,
    principal: Principal,
  ): void {
    const key = topicRoutingKey(ref)
    const fresh = this.deps.subscriptions.subscribe(key, { subscriberId, principal })
    if (!fresh || this.states.has(key)) return
    this.generation += 1
    this.states.set(key, {
      ref,
      key: topicKey(ref.kind, ref.id),
      // A key that starts over gets a new epoch, so a client never compares a
      // position from before the gap with one after it (D19).
      epoch: `${this.epochBase}.${this.generation}`,
      seq: 0,
    })
    this.producerCall(ref, 'start')
  }

  private remove(key: RoutingKey, subscriberId: SubscriberId): void {
    if (!this.deps.subscriptions.unsubscribe(key, subscriberId)) return
    this.resendStreak.delete(pairKey(subscriberId, key))
    this.settleIfEmpty(key)
  }

  /** The last subscriber left (by any path): forget the key and stop its producer. */
  private settleIfEmpty(key: RoutingKey): void {
    if (this.deps.subscriptions.subscribers(key).length > 0) return
    const state = this.states.get(key)
    if (!state) return
    if (state.timer !== undefined) this.timers.clearTimeout(state.timer)
    this.states.delete(key)
    this.producerCall(state.ref, 'stop')
  }

  private producerCall(ref: TopicRef & { readonly kind: TopicKind }, verb: 'start' | 'stop'): void {
    try {
      this.deps.producers[ref.kind][verb]?.(ref.id)
    } catch (err) {
      log.warn('topic producer failed', { kind: ref.kind, verb, err })
    }
  }

  private snapshotFrame(state: KeyState): TopicServerMessage {
    const decl = TOPIC_KINDS[state.ref.kind]
    const payload =
      decl.style === 'value'
        ? this.deps.producers[state.ref.kind].snapshot?.(state.ref.id)
        : undefined
    return {
      type: 'topicSnapshot',
      key: state.key,
      position: { epoch: state.epoch, seq: state.seq },
      ...(payload !== undefined ? { payload } : {}),
    }
  }

  private sendSnapshot(subscriberId: SubscriberId, key: RoutingKey): void {
    const state = this.states.get(key)
    if (!state || isInternal(subscriberId)) return
    this.deliverValue(subscriberId, key, this.snapshotFrame(state))
  }

  private sendUpdate(state: KeyState, payload: unknown): void {
    state.seq += 1
    state.lastSentAt = this.now()
    const key = topicRoutingKey(state.ref)
    const outcome = this.router.publish(key, {
      type: 'topicUpdate',
      key: state.key,
      position: { epoch: state.epoch, seq: state.seq },
      ...(payload !== undefined ? { payload } : {}),
    })
    // Coalescing by key makes this unreachable at the cap, but the registry was
    // changed by the router itself, so the producer rule still has to run.
    for (const subscriberId of outcome.evicted) this.overflowed(subscriberId, key, state.key)
    this.scheduleFlush()
  }

  private releasePending(state: KeyState): void {
    state.timer = undefined
    const pending = state.pending
    state.pending = undefined
    if (pending && this.states.get(topicRoutingKey(state.ref)) === state) {
      this.sendUpdate(state, pending.payload)
    }
  }

  /** Hand one value frame to the socket; a refusal re-sends the newest later. */
  private deliverValue(
    subscriberId: SubscriberId,
    key: RoutingKey,
    frame: TopicServerMessage,
  ): void {
    const pair = pairKey(subscriberId, key)
    if (this.deps.clients.deliverStream(String(subscriberId), frame)) {
      this.resendStreak.delete(pair)
      return
    }
    if (!this.deps.clients.get(String(subscriberId))) return
    const streak = (this.resendStreak.get(pair) ?? 0) + 1
    if (streak >= TOPIC_RESEND_LIMIT) {
      this.resendStreak.delete(pair)
      const state = this.states.get(key)
      if (state) this.overflowed(subscriberId, key, state.key)
      return
    }
    this.resendStreak.set(pair, streak)
    this.scheduleResend()
  }

  private overflowed(subscriberId: SubscriberId, key: RoutingKey, wireKey: TopicKey): void {
    this.deps.subscriptions.unsubscribe(key, subscriberId)
    this.resendStreak.delete(pairKey(subscriberId, key))
    const conn = this.deps.clients.get(String(subscriberId))
    if (conn) this.close(conn, wireKey, 'overflow')
    this.settleIfEmpty(key)
  }

  private scheduleResend(): void {
    if (this.resendTimer !== undefined) return
    this.resendTimer = this.timers.setTimeout(() => {
      this.resendTimer = undefined
      for (const pair of [...this.resendStreak.keys()]) {
        const at = pair.indexOf('\n')
        const subscriberId = asSubscriberId(pair.slice(0, at))
        const key = pair.slice(at + 1) as RoutingKey
        if (!this.deps.subscriptions.has(key, subscriberId)) {
          this.resendStreak.delete(pair)
          continue
        }
        // The NEWEST value, as a snapshot: whatever was refused is superseded.
        const state = this.states.get(key)
        if (state) this.deliverValue(subscriberId, key, this.snapshotFrame(state))
      }
    }, TOPIC_RESEND_DELAY_MS)
  }

  /** Deterministic test seam; production drains on the next microtask. */
  flushNow(): void {
    this.flushScheduled = false
    for (const subscriberId of this.router.pendingSubscribers()) {
      const frames = this.router.drain(subscriberId)
      if (isInternal(subscriberId)) continue
      for (const frame of frames) {
        const ref = parseTopicKey(frame.key)
        if (ref) this.deliverValue(subscriberId, topicRoutingKey(ref), frame)
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flushNow())
  }

  /** `topicClosed` takes the ordinary send: a close the client never hears strands its holders. */
  private close(conn: ClientConn, key: TopicKey, reason: TopicClosedReason): void {
    this.deps.clients.deliver(conn, { type: 'topicClosed', key, reason })
  }

  private topicKeyCount(subscriberId: SubscriberId): number {
    let count = 0
    for (const key of this.deps.subscriptions.keysOf(subscriberId)) {
      if (topicRefFromRoutingKey(key)) count += 1
    }
    return count
  }

  /**
   * The kind's resolver for each ref, against `principal` (or `principals[i]`).
   * Only `machine` needs a kernel read, and it is one batch for all refs.
   */
  private async visibleTo(
    principal: Principal | undefined,
    refs: readonly { readonly kind: TopicKind; readonly id: string }[],
    principals?: readonly Principal[],
  ): Promise<boolean[]> {
    const who = (index: number): Principal => (principals?.[index] ?? principal) as Principal
    const machines = refs.filter((ref) => TOPIC_KINDS[ref.kind].visibility === 'machine')
    const resolver =
      machines.length > 0
        ? await this.deps.prepareVisibility(
            machines.map((ref) => ({ kind: 'machine', id: ref.id })),
          )
        : undefined
    return refs.map((ref, index) => {
      const p = who(index)
      switch (TOPIC_KINDS[ref.kind].visibility) {
        case 'machine':
          return resolver?.canSee(p, { kind: 'machine', id: ref.id }) === true
        case 'account.self':
          return p.kind === 'user' && String(p.user) === ref.id
        default:
          return false
      }
    })
  }
}

/**
 * A daemon kind's producer (D21): start and stop become `topicWatch on|off` to
 * the machine that produces the id, sent only to a daemon that accepted
 * `topics.v1`. Older daemons keep their pre-topics path, and the server serves
 * the topic from it, so the subscriber sees one path either way.
 */
export function daemonTopicProducer(input: {
  readonly kind: TopicKind
  readonly machineOf: (id: string) => MachineId | undefined
  readonly supportsTopics: (machineId: MachineId) => boolean
  readonly send: (
    machineId: MachineId,
    frame: { type: 'topicWatch'; key: TopicKey; on: boolean },
  ) => void
  readonly snapshot?: (id: string) => unknown
}): TopicProducer {
  const watch = (id: string, on: boolean): void => {
    const machineId = input.machineOf(id)
    if (machineId === undefined || !input.supportsTopics(machineId)) return
    input.send(machineId, { type: 'topicWatch', key: topicKey(input.kind, id), on })
  }
  return {
    start: (id) => watch(id, true),
    stop: (id) => watch(id, false),
    machineOf: input.machineOf,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
  }
}
