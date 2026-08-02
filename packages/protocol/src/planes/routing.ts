import {
  type EntityRef,
  joinKeyParts,
  splitKeyParts,
} from '@podium/model'
import { PLANE_CLASS_SEMANTICS, type PlaneClass } from './plane'
import { type Principal, principalRoutingId } from './principal'

/**
 * THE ONE ROUTING PRIMITIVE — ADR 7 Amendment 1 D13.
 *
 * The mechanism that routes per-room presence fan-out (stream · live) and the
 * mechanism that routes the per-principal scoped feed (control · entity, ADR 2
 * Amendment 1) are THE SAME primitive: a subscription registry mapping a
 * routing key to a set of subscribers, plus the principal→visible-entity
 * resolution the visibility gate consults. What differs is DURABILITY, NOT
 * ROUTING (D13's table), so durability is a PARAMETER of the router built over
 * the one registry — never a second registry.
 *
 *   const registry = new SubscriptionRegistry()
 *   const entityRouter   = new PlaneRouter(registry, CONTROL_ENTITY_DELIVERY)
 *   const presenceRouter = new PlaneRouter(registry, STREAM_PRESENCE_DELIVERY)
 *
 * Two independent subscription registries is a DEFECT against POD-387 and the
 * Phase 4 exit gate (POD-425) checks for it. `SubscriptionRegistry` is
 * therefore the only registry in this package, and `PlaneRouter` is the only
 * thing that fans out over it.
 *
 * Routing is a SET LOOKUP, never a per-reader projection (ADR 7 Amendment 1
 * D15.1): one wire value, many destinations. Nothing here reads a frame's
 * contents, so a reader-dependent projection is unrepresentable.
 */

/** Stable identity of one subscribed connection. */
export type SubscriberId = string & { readonly __brand: 'SubscriberId' }
export const asSubscriberId = (s: string): SubscriberId => s as SubscriberId

/**
 * An opaque routing key. Built only by the constructors below, all of which
 * take an ENTITY REFERENCE or a principal — never a free string (ADR 7
 * Amendment 1 D10.2: a free-string namespace has no owner, no totality test,
 * and nothing to check a permission against).
 *
 * COMPOSITE PARTS ARE ESCAPED via {@link joinKeyParts} (POD-1134): unescaped
 * `kind:id` concatenation collides (`a`+`b:c` vs `a:b`+`c`), so one subscriber
 * set would serve two entities. For separator-free parts the byte shape is
 * identical to the pre-POD-1134 ad-hoc keys.
 */
export type RoutingKey = string & { readonly __brand: 'RoutingKey' }

/**
 * Entity references for routing live in `@podium/model` — the closed
 * kind+branded-id union pinned by `ENTITY_KINDS`. Re-exported here so plane
 * ports share ONE type with the composite-key home (POD-1134). Bulk non-entity
 * streams (transcript pages, file bodies) are a DISTINCT kind space: see
 * `BulkResourceRef` on the bulk port — they never enter this registry.
 */
export type { EntityRef }

const ROUTING_SEP = ':'

/** Structural shape accepted by key constructors: kind + id, both non-empty. */
type RoutingEntityParts = { readonly kind: string; readonly id: string }

const requireRoutingParts = (ref: RoutingEntityParts, what: string): void => {
  if (ref.kind === '') throw new Error(`${what} kind must not be empty`)
  if (ref.id === '') throw new Error(`${what} id must not be empty`)
}

/**
 * Key for control · entity fan-out of one entity's rows: the subscribers are
 * the connections whose principal may see that entity.
 *
 * Callers should pass a model {@link EntityRef}. The parameter is structural so
 * a room ref (session|issue) and a branded entity ref share one constructor
 * without a second named EntityRef type in this package.
 */
export const entityRoutingKey = (ref: RoutingEntityParts): RoutingKey => {
  requireRoutingParts(ref, 'entity routing key')
  return joinKeyParts(ROUTING_SEP, ['entity', ref.kind, ref.id]) as RoutingKey
}

/** Inverse of {@link entityRoutingKey}. Throws on a malformed or wrong-arity key. */
export const parseEntityRoutingKey = (key: string): { kind: string; id: string } => {
  const [ns, kind, id] = splitKeyParts(ROUTING_SEP, key, 3) as [string, string, string]
  if (ns !== 'entity') {
    throw new Error(`malformed entity routing key (expected entity namespace): ${JSON.stringify(key)}`)
  }
  if (kind === '' || id === '') {
    throw new Error(`malformed entity routing key (empty part): ${JSON.stringify(key)}`)
  }
  return { kind, id }
}

/**
 * Key for stream · live per-room fan-out (ADR 7 Amendment 1 D10).
 * Room join APIs take the closed `RoomRef` set; this constructor only joins.
 */
export const roomRoutingKey = (ref: RoutingEntityParts): RoutingKey => {
  requireRoutingParts(ref, 'room routing key')
  return joinKeyParts(ROUTING_SEP, ['room', ref.kind, ref.id]) as RoutingKey
}

/**
 * Inverse of {@link roomRoutingKey}. Throws on a malformed or wrong-arity key.
 * Stream callers that only accept `session`/`issue` rooms narrow further
 * (see `roomRefFromRoutingKey`).
 */
export const parseRoomRoutingKey = (key: string): { kind: string; id: string } => {
  const [ns, kind, id] = splitKeyParts(ROUTING_SEP, key, 3) as [string, string, string]
  if (ns !== 'room') {
    throw new Error(`malformed room routing key (expected room namespace): ${JSON.stringify(key)}`)
  }
  if (kind === '' || id === '') {
    throw new Error(`malformed room routing key (empty part): ${JSON.stringify(key)}`)
  }
  return { kind, id }
}

/**
 * Key for frames directed at one principal's feed rather than at an entity:
 * watermark-bearing delta frames with no visible changes, and `rescope`
 * (ADR 2 Amendment 1 D13/D14.4).
 *
 * The principal half is the opaque output of {@link principalRoutingId}, not a
 * free (kind, id) pair. Escaping that whole string as one part would change the
 * legacy `principal:user:…` byte shape for every live principal (they always
 * contain colons). Injectivity of the principal id itself is
 * `principalRoutingId`'s job; this constructor only namespaces it.
 */
export const principalRoutingKeyFromId = (principalId: string): RoutingKey =>
  `principal:${principalId}` as RoutingKey

export const principalRoutingKey = (p: Principal): RoutingKey =>
  principalRoutingKeyFromId(principalRoutingId(p))

export interface Subscription {
  readonly subscriberId: SubscriberId
  readonly principal: Principal
}

/**
 * The single subscription registry. Pure in-memory bookkeeping: no IO, no
 * policy, no frame inspection. POD-317 owns exactly one instance of it.
 */
export class SubscriptionRegistry {
  private readonly byKey = new Map<RoutingKey, Map<SubscriberId, Subscription>>()
  private readonly bySubscriber = new Map<SubscriberId, Set<RoutingKey>>()

  /** Idempotent. Returns true iff this call created the subscription. */
  subscribe(key: RoutingKey, sub: Subscription): boolean {
    let subs = this.byKey.get(key)
    if (!subs) {
      subs = new Map()
      this.byKey.set(key, subs)
    }
    const fresh = !subs.has(sub.subscriberId)
    subs.set(sub.subscriberId, sub)
    let keys = this.bySubscriber.get(sub.subscriberId)
    if (!keys) {
      keys = new Set()
      this.bySubscriber.set(sub.subscriberId, keys)
    }
    keys.add(key)
    return fresh
  }

  /** Returns true iff a subscription was removed. */
  unsubscribe(key: RoutingKey, subscriberId: SubscriberId): boolean {
    const subs = this.byKey.get(key)
    const removed = subs?.delete(subscriberId) ?? false
    if (subs && subs.size === 0) this.byKey.delete(key)
    const keys = this.bySubscriber.get(subscriberId)
    if (keys) {
      keys.delete(key)
      if (keys.size === 0) this.bySubscriber.delete(subscriberId)
    }
    return removed
  }

  /**
   * Connection closed. Leaves are DERIVED from connection lifecycle (ADR 7
   * Amendment 1 D10.6): explicit unsubscribe, close and heartbeat reap all
   * funnel through here, so no ghost occupant can survive a killed tab.
   * Returns the keys the subscriber held, for leave notification.
   */
  dropSubscriber(subscriberId: SubscriberId): RoutingKey[] {
    const keys = [...(this.bySubscriber.get(subscriberId) ?? [])]
    for (const key of keys) this.unsubscribe(key, subscriberId)
    return keys
  }

  subscribers(key: RoutingKey): readonly Subscription[] {
    return [...(this.byKey.get(key)?.values() ?? [])]
  }

  has(key: RoutingKey, subscriberId: SubscriberId): boolean {
    return this.byKey.get(key)?.has(subscriberId) ?? false
  }

  keysOf(subscriberId: SubscriberId): readonly RoutingKey[] {
    return [...(this.bySubscriber.get(subscriberId) ?? [])]
  }

  /**
   * Membership is per PRINCIPAL, not per connection (ADR 7 Amendment 1 D9.4):
   * two tabs are one member with two connections, and a member leaves when its
   * LAST subscribed connection leaves.
   */
  members(key: RoutingKey): ReadonlyMap<string, readonly Subscription[]> {
    const out = new Map<string, Subscription[]>()
    for (const sub of this.subscribers(key)) {
      const id = principalRoutingId(sub.principal)
      const list = out.get(id)
      if (list) list.push(sub)
      else out.set(id, [sub])
    }
    return out
  }

  get keyCount(): number {
    return this.byKey.size
  }

  get subscriberCount(): number {
    return this.bySubscriber.size
  }
}

/** The one property that differs between the primitive's two consumers. */
export type Durability = 'durable' | 'ephemeral'

/**
 * Terminal escalation when a subscriber cannot keep up.
 * - `demote-to-resync` — ADR 2 D9: the durable side never drops a frame; a
 *   slow replica is demoted and heals through the D7 ladder.
 * - `evict` — ADR 7 Amendment 1 D11.5: coalesce → drop → evict from the room.
 *   The connection SURVIVES and its control-plane delivery is unaffected;
 *   socket termination is never an outcome of stream overload.
 */
export type OverflowPolicy = 'demote-to-resync' | 'evict'

export interface DeliveryPolicy<M> {
  readonly planeClass: PlaneClass
  readonly durability: Durability
  /** Bounded outbound queue per subscriber. */
  readonly maxQueued: number
  /**
   * Ephemeral only: the coalescing identity of a frame. Because stream
   * payloads are idempotent FULL STATE (ADR 7 Amendment 1 D9.3), a queued
   * frame superseded by a newer one for the same identity may be replaced —
   * latest-wins per member is the fan-out's only ordering obligation.
   * Durable frames MUST NOT define one: coalescing an ordered, contiguity-
   * checked feed would drop certified ranges.
   */
  readonly coalesceKey?: (frame: M) => string
  /** Consecutive drops on one key before the subscriber is evicted from it. */
  readonly evictAfterDrops?: number
  readonly onOverflow: OverflowPolicy
}

export interface RouteOutcome {
  /** Subscribers whose queue now holds the frame. */
  readonly delivered: readonly SubscriberId[]
  /** Subscribers where a superseded queued frame was replaced. */
  readonly coalesced: readonly SubscriberId[]
  /** Subscribers for whom the frame was discarded (ephemeral only). */
  readonly dropped: readonly SubscriberId[]
  /** Subscribers removed from this key (ephemeral terminal escalation). */
  readonly evicted: readonly SubscriberId[]
  /** Subscribers that must re-bootstrap / heal (durable terminal escalation). */
  readonly demoted: readonly SubscriberId[]
}

interface Queued<M> {
  readonly key: RoutingKey
  readonly frame: M
  readonly coalesceKey?: string
}

/**
 * Fan-out over {@link SubscriptionRegistry}, parameterized by durability.
 *
 * The router owns the send-edge policy (bounded queue, coalescing, escalation)
 * and NOT the recipient set — that is the registry's, which is why there is no
 * per-send-site recipient computation left to write (ADR 7 Amendment 1 D15.2).
 */
export class PlaneRouter<M> {
  private readonly queues = new Map<SubscriberId, Queued<M>[]>()
  private readonly dropStreak = new Map<string, number>()
  private readonly needsResync = new Set<SubscriberId>()

  constructor(
    readonly registry: SubscriptionRegistry,
    readonly policy: DeliveryPolicy<M>,
  ) {
    const semantics = PLANE_CLASS_SEMANTICS[policy.planeClass]
    // The parameterization must agree with the plane's own contract: a lossy
    // plane is ephemeral, a healed plane is durable. Getting this wrong is the
    // "make presence durable / make the feed lossy" trap D13 rejects.
    if (semantics.lossy !== (policy.durability === 'ephemeral')) {
      throw new Error(
        `plane class ${policy.planeClass} is ${semantics.lossy ? 'lossy' : 'durable'}; ` +
          `refusing durability=${policy.durability}`,
      )
    }
    if (policy.durability === 'durable' && policy.coalesceKey) {
      throw new Error('durable delivery must not coalesce: contiguity is certified per frame')
    }
    if (policy.durability === 'ephemeral' && !semantics.lossy) {
      throw new Error('ephemeral delivery requires a lossy plane class')
    }
  }

  /** Publish one wire value to every subscriber of `key`. */
  publish(key: RoutingKey, frame: M): RouteOutcome {
    const delivered: SubscriberId[] = []
    const coalesced: SubscriberId[] = []
    const dropped: SubscriberId[] = []
    const evicted: SubscriberId[] = []
    const demoted: SubscriberId[] = []
    const coalesceKey = this.policy.coalesceKey?.(frame)

    for (const sub of this.registry.subscribers(key)) {
      const id = sub.subscriberId
      const queue = this.queues.get(id) ?? []
      if (!this.queues.has(id)) this.queues.set(id, queue)

      // 1. Coalesce (ephemeral only, and mandatory before dropping).
      if (coalesceKey !== undefined) {
        const at = queue.findIndex((q) => q.key === key && q.coalesceKey === coalesceKey)
        if (at >= 0) {
          queue[at] = { key, frame, coalesceKey }
          coalesced.push(id)
          this.dropStreak.delete(`${id}\n${key}`)
          continue
        }
      }

      if (queue.length < this.policy.maxQueued) {
        queue.push({ key, frame, coalesceKey })
        delivered.push(id)
        this.dropStreak.delete(`${id}\n${key}`)
        continue
      }

      // 2. Over budget. The two durabilities part company here, and only here.
      if (this.policy.onOverflow === 'demote-to-resync') {
        // Durable: never silently drop a certified frame. Shed the queue and
        // demote; the replica heals through ADR 2 D7's ladder.
        this.queues.set(id, [])
        this.needsResync.add(id)
        demoted.push(id)
        continue
      }

      const streakKey = `${id}\n${key}`
      const streak = (this.dropStreak.get(streakKey) ?? 0) + 1
      this.dropStreak.set(streakKey, streak)
      dropped.push(id)
      const limit = this.policy.evictAfterDrops
      if (limit !== undefined && streak >= limit) {
        // 3. Terminal escalation: evict from THIS key only. The connection
        // survives; the client rejoins and gets a fresh snapshot.
        this.registry.unsubscribe(key, id)
        this.dropStreak.delete(streakKey)
        evicted.push(id)
      }
    }

    return { delivered, coalesced, dropped, evicted, demoted }
  }

  /** Frames queued for one subscriber, oldest first; clears the queue. */
  drain(subscriberId: SubscriberId): readonly M[] {
    const queue = this.queues.get(subscriberId) ?? []
    this.queues.set(subscriberId, [])
    return queue.map((q) => q.frame)
  }

  queued(subscriberId: SubscriberId): number {
    return this.queues.get(subscriberId)?.length ?? 0
  }

  /** Subscribers with frames waiting at the transport edge. */
  pendingSubscribers(): readonly SubscriberId[] {
    return [...this.queues.entries()].flatMap(([id, queue]) => (queue.length > 0 ? [id] : []))
  }

  /** True while a durable subscriber owes a re-bootstrap (ADR 2 D9 / D7 rung 2). */
  isDemoted(subscriberId: SubscriberId): boolean {
    return this.needsResync.has(subscriberId)
  }

  clearDemotion(subscriberId: SubscriberId): void {
    this.needsResync.delete(subscriberId)
  }

  /** Connection closed: drop its subscriptions and its queue. */
  forget(subscriberId: SubscriberId): readonly RoutingKey[] {
    const keys = this.registry.dropSubscriber(subscriberId)
    this.queues.delete(subscriberId)
    this.needsResync.delete(subscriberId)
    for (const key of keys) this.dropStreak.delete(`${subscriberId}\n${key}`)
    return keys
  }
}

/**
 * The control · entity parameterization: durable, ordered, never coalesced,
 * demoted to resync under pressure (ADR 2 D9).
 */
export const controlEntityDelivery = <M>(maxQueued: number): DeliveryPolicy<M> => ({
  planeClass: 'control.entity',
  durability: 'durable',
  maxQueued,
  onOverflow: 'demote-to-resync',
})

/**
 * The stream · live parameterization: lossy, latest-wins per member, escalating
 * coalesce → drop → evict (ADR 7 Amendment 1 D11.5).
 */
export const streamLiveDelivery = <M>(
  maxQueued: number,
  coalesceKey: (frame: M) => string,
  evictAfterDrops: number,
): DeliveryPolicy<M> => ({
  planeClass: 'stream.live',
  durability: 'ephemeral',
  maxQueued,
  coalesceKey,
  evictAfterDrops,
  onOverflow: 'evict',
})
