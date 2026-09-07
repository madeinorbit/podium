/**
 * Production composition of ADR 7's stream port over the gateway's ONE
 * subscription registry. Room semantics remain in the protocol port; this
 * adapter only binds authenticated connections, the lossy socket sink, and the
 * microtask that drains bounded/coalescing queues.
 */

import {
  asSubscriberId,
  PlaneRouter,
  type PlaneTarget,
  type PresenceIdentity,
  type PresenceRoomClientMessage,
  type PresenceRoomServerMessage,
  type Principal,
  presenceCoalesceKey,
  type RoomRef,
  roomRefFromRoutingKey,
  StreamPlanePort,
  type SubscriberId,
  type SubscriptionRegistry,
  streamLiveDelivery,
  type VisibilityResolver,
} from '@podium/protocol'
import type { ClientConn, ClientRegistry } from './client-registry'

export const STREAM_QUEUE_MAX_FRAMES = 64
export const STREAM_EVICT_AFTER_DROPS = 3
export const STREAM_PUBLISH_MAX_HZ = 60

export interface PresenceRoutingDeps {
  readonly subscriptions: SubscriptionRegistry
  readonly clients: ClientRegistry
  readonly prepareVisibility: (rooms: readonly RoomRef[]) => Promise<VisibilityResolver>
  readonly now?: () => number
}

const identityOf = (principal: Principal): PresenceIdentity => {
  if (principal.kind === 'user') return { kind: 'user', user: principal.user }
  if (principal.kind === 'agent') {
    return {
      kind: 'agent',
      agentIdentity: principal.agentIdentity,
      onBehalfOf: principal.onBehalfOf,
    }
  }
  throw new Error('machine and system principals cannot publish browser presence')
}

const pressureKey = (subscriberId: SubscriberId, room: RoomRef): string =>
  String(subscriberId) + '\n' + room.kind + ':' + room.id

/**
 * The browser-facing stream route. It owns no visibility policy and no room
 * meaning: both are injected/opaque. Every outbound room delta is charged to a
 * bounded stream queue and then to ClientConn.sendStream, whose lower socket
 * budget drops rather than terminating the control connection.
 */
export class PresenceRouting {
  private readonly router: PlaneRouter<PresenceRoomServerMessage>
  private readonly port: StreamPlanePort
  private readonly now: () => number
  private readonly lastUpdateAt = new Map<string, number>()
  private readonly pressureDrops = new Map<string, number>()
  private flushScheduled = false
  private joiningVisibility: VisibilityResolver | undefined

  constructor(private readonly deps: PresenceRoutingDeps) {
    this.now = deps.now ?? (() => performance.now())
    this.router = new PlaneRouter(
      deps.subscriptions,
      streamLiveDelivery(STREAM_QUEUE_MAX_FRAMES, presenceCoalesceKey, STREAM_EVICT_AFTER_DROPS),
    )
    this.port = new StreamPlanePort(deps.subscriptions, this.router, {
      visibility: {
        canSee: (principal, room) => this.joiningVisibility?.canSee(principal, room) === true,
      },
      identityOf,
      emit: (subscriberId, frame) => {
        deps.clients.deliverStream(subscriberId, frame)
      },
    })
  }

  target(conn: ClientConn): PlaneTarget {
    return { subscriberId: asSubscriberId(conn.id), principal: conn.principal }
  }

  async route(conn: ClientConn, frame: PresenceRoomClientMessage): Promise<RoomRef | undefined> {
    const target = this.target(conn)
    switch (frame.type) {
      case 'presenceSubscribe':
        if (await this.join(conn, frame.room, frame.token)) {
          this.scheduleFlush()
          return frame.room
        }
        this.scheduleFlush()
        return
      case 'presenceUnsubscribe':
        this.port.leave(target, frame.room)
        this.scheduleFlush()
        return
      case 'presenceUpdate':
        if (!this.admitUpdate(target.subscriberId, frame.room)) return
        this.port.publishPresence(target, frame.room, frame.payload, frame.visible)
        if (frame.visible !== undefined) conn.visible = frame.visible
        this.scheduleFlush()
        return
      default:
        frame satisfies never
    }
  }

  /** Forward mapping of the legacy room-less page visibility frame. */
  setVisible(conn: ClientConn, visible: boolean): void {
    conn.visible = visible
    this.port.setVisible(this.target(conn), visible)
  }

  disconnect(conn: ClientConn): void {
    const subscriberId = asSubscriberId(conn.id)
    this.port.disconnect(subscriberId)
    for (const key of this.lastUpdateAt.keys()) {
      if (key.startsWith(String(subscriberId) + '\n')) this.lastUpdateAt.delete(key)
    }
    for (const key of this.pressureDrops.keys()) {
      if (key.startsWith(String(subscriberId) + '\n')) this.pressureDrops.delete(key)
    }
    this.scheduleFlush()
  }

  occupancy(room: RoomRef) {
    return this.port.occupancy(room)
  }

  /**
   * Server-side room membership for a PTY attach (POD-1081). Watching a
   * terminal joins the session room so `clientCount` can be derived from
   * occupancy rather than a second attach counter. Idempotent.
   */
  async ensureJoined(conn: ClientConn, room: RoomRef): Promise<boolean> {
    const joined = await this.join(conn, room)
    this.scheduleFlush()
    return joined
  }

  private async join(conn: ClientConn, room: RoomRef, token?: string): Promise<boolean> {
    const visibility = await this.deps.prepareVisibility([room])
    // The read may outlive the socket. Never resurrect a disconnected member.
    if (this.deps.clients.get(conn.id) !== conn) return false
    // Only the synchronous port pass can see this request's snapshot. No await
    // inside this scope, and no cached grant survives into the next admission.
    const previous = this.joiningVisibility
    this.joiningVisibility = visibility
    try {
      return this.port.join(this.target(conn), room, token)
    } finally {
      this.joiningVisibility = previous
    }
  }

  /** Inverse of {@link ensureJoined} — detach leaves the session room. */
  ensureLeft(conn: ClientConn, room: RoomRef): void {
    this.port.leave(this.target(conn), room)
    this.scheduleFlush()
  }

  isWatchedBy(principal: Principal): boolean {
    return this.port.isWatchedBy(principal)
  }

  /** Re-check live rooms after the durable feed reports an evict or rescope. */
  async revalidateSubscribers(subscriberIds: readonly SubscriberId[]): Promise<void> {
    const candidates = subscriberIds.flatMap((subscriberId) => {
      const conn = this.deps.clients.get(String(subscriberId))
      if (!conn) return []
      return this.deps.subscriptions.keysOf(subscriberId).flatMap((key) => {
        const room = roomRefFromRoutingKey(key)
        return room ? [{ conn, subscriberId, key, room }] : []
      })
    })
    if (candidates.length === 0) return
    const visibility = await this.deps.prepareVisibility(candidates.map(({ room }) => room))
    for (const { conn, subscriberId, key, room } of candidates) {
      if (
        this.deps.clients.get(conn.id) !== conn ||
        !this.deps.subscriptions.has(key, subscriberId)
      ) continue
      if (visibility.canSee(conn.principal, room) === true) continue
      this.port.evict(this.target(conn), room)
    }
    this.scheduleFlush()
  }

  /** Deterministic test seam; production normally drains on the next microtask. */
  flushNow(): void {
    this.flushScheduled = false
    for (const subscriberId of this.router.pendingSubscribers()) {
      for (const frame of this.router.drain(subscriberId)) {
        const key = pressureKey(subscriberId, frame.room)
        if (this.deps.clients.deliverStream(subscriberId, frame)) {
          this.pressureDrops.delete(key)
          continue
        }
        const drops = (this.pressureDrops.get(key) ?? 0) + 1
        this.pressureDrops.set(key, drops)
        if (drops < STREAM_EVICT_AFTER_DROPS) continue
        this.pressureDrops.delete(key)
        const conn = this.deps.clients.get(String(subscriberId))
        if (conn) this.port.evict(this.target(conn), frame.room)
      }
    }
    if (this.router.pendingSubscribers().length > 0) this.scheduleFlush()
  }

  private admitUpdate(subscriberId: SubscriberId, room: RoomRef): boolean {
    const key = pressureKey(subscriberId, room)
    const now = this.now()
    const last = this.lastUpdateAt.get(key)
    if (last !== undefined && now - last < 1_000 / STREAM_PUBLISH_MAX_HZ) return false
    this.lastUpdateAt.set(key, now)
    return true
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flushNow())
  }
}
