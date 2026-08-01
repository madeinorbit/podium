import type { PlaneTarget } from './control-port'
import type { PlaneClass } from './plane'
import {
  type PresenceIdentity,
  type PresenceMember,
  type PresencePayload,
  type PresenceRoomServerMessage,
  presencePayloadWithinBudget,
  type RoomRef,
} from './presence-rooms'
import { type Principal, principalRoutingId, type VisibilityResolver } from './principal'
import {
  type PlaneRouter,
  type RoutingKey,
  roomRoutingKey,
  type SubscriberId,
  type SubscriptionRegistry,
} from './routing'

/**
 * THE STREAM PORT — ADR 7 D1 (live port) as extended by ADR 7 Amendment 1
 * D9–D12: best-effort delivery to a NAMED ROUTING SET (one connection, a
 * session-attach set, or a ROOM). "Raw fan-out to every client" is no longer a
 * port affordance (D15).
 *
 * Guarantees are unchanged in kind: lossy, tolerant of reordering, NEVER healed,
 * blank offline, NO durable rows and no tombstones (D12). Nothing on this port
 * enters the write funnel or appends an oplog row, so `seq` is unmoved by
 * presence traffic under any load (D11.1).
 *
 * Rooms are a SUBSCRIPTION CONCEPT INSIDE THIS PORT — not a fourth plane.
 */

export interface StreamPortDeps {
  readonly visibility: VisibilityResolver
  readonly emit: (subscriberId: SubscriberId, frame: PresenceRoomServerMessage) => void
  /** Stamp the wire identity from the transport principal — never from payload. */
  readonly identityOf: (principal: Principal) => PresenceIdentity
}

export interface StreamPort {
  readonly planeClasses: readonly PlaneClass[]
  join(target: PlaneTarget, room: RoomRef, token?: string): boolean
  leave(target: PlaneTarget, room: RoomRef): void
  publishPresence(
    target: PlaneTarget,
    room: RoomRef,
    payload?: PresencePayload,
    visible?: boolean,
  ): void
  occupancy(room: RoomRef): readonly PresenceMember[]
  disconnect(subscriberId: SubscriberId): void
  /** Compatibility mapping for the old room-less page visibility frame. */
  setVisible(target: PlaneTarget, visible: boolean): void
  /** The forward mapping of today's anonymous `visible` bit (D9.5). */
  isWatchedBy(principal: Principal): boolean
}

interface MemberState {
  readonly identity: PresenceIdentity
  payload?: PresencePayload
  visible?: boolean
}

/**
 * Reference implementation over the ONE routing primitive. `router` must be
 * parameterized `stream.live` / ephemeral with a coalescing key — the router's
 * constructor refuses anything else.
 *
 * All presence state lives in these in-memory maps and dies with the
 * connections that produced it: no table, no oplog row, no entity field, no
 * replica row, no tombstone (D12).
 */
export class StreamPlanePort implements StreamPort {
  readonly planeClasses = ['stream.live'] as const

  /** room key → principal routing id → last full state. */
  private readonly rooms = new Map<RoutingKey, Map<string, MemberState>>()
  /** connection → last reported `visible` bit, for the notification router. */
  private readonly visibleByConnection = new Map<SubscriberId, boolean>()
  private readonly principalOfConnection = new Map<SubscriberId, Principal>()

  constructor(
    private readonly registry: SubscriptionRegistry,
    private readonly router: PlaneRouter<PresenceRoomServerMessage>,
    private readonly deps: StreamPortDeps,
  ) {
    if (router.registry !== registry) {
      throw new Error('stream port router must share the one subscription registry')
    }
    if (router.policy.planeClass !== 'stream.live') {
      throw new Error(`stream port needs a stream.live router, got ${router.policy.planeClass}`)
    }
    if (!router.policy.coalesceKey) {
      // Coalescing is legal AND MANDATORY before dropping (D11.3), because
      // payloads are idempotent full state.
      throw new Error('stream port requires a coalescing router')
    }
  }

  /**
   * Join a room. Visibility-gated and default-closed (D14.1); refusal and
   * nonexistence produce the IDENTICAL `presenceRoomClosed` with no reason code
   * (D14.3), so a subscribe frame is not an existence oracle.
   *
   * On success the port sends a FULL OCCUPANCY SNAPSHOT in one frame (D10.5):
   * an idle room must be distinguishable from an empty one.
   */
  join(target: PlaneTarget, room: RoomRef, token?: string): boolean {
    if (this.deps.visibility.canSee(target.principal, room) !== true) {
      this.deps.emit(target.subscriberId, {
        type: 'presenceRoomClosed',
        room,
        ...(token === undefined ? {} : { token }),
      })
      return false
    }
    const key = roomRoutingKey(room)
    this.registry.subscribe(key, {
      subscriberId: target.subscriberId,
      principal: target.principal,
    })
    this.principalOfConnection.set(target.subscriberId, target.principal)

    const members = this.memberMap(key)
    const memberId = principalRoutingId(target.principal)
    const known = members.get(memberId)
    if (!known) {
      members.set(memberId, { identity: this.deps.identityOf(target.principal) })
    }

    // The join ANSWER goes straight to the one connection rather than through the
    // fan-out queue: it is the frame that makes an idle room distinguishable from
    // an empty one (D10.5), so it must not be coalesced away or dropped by the
    // per-room budget that governs cursor traffic (D11).
    this.deps.emit(target.subscriberId, {
      type: 'presenceRoomState',
      room,
      members: [...this.snapshot(key)],
      ...(token === undefined ? {} : { token }),
    })

    // A newly present member is a join for everyone else; a second tab of an
    // existing member is not (D10.4/D10.6 — membership is per principal).
    if (!known) {
      this.fanOut(key, room, 'joined', memberId)
    }
    return true
  }

  /** Explicit leave. Close and heartbeat reap route through {@link disconnect}. */
  leave(target: PlaneTarget, room: RoomRef): void {
    this.leaveKey(target.subscriberId, roomRoutingKey(room), room)
  }

  /**
   * Publish this connection's payload into a joined room. The identity is
   * stamped from the transport; an over-budget payload is refused, not
   * truncated. A connection that has not joined publishes nothing.
   */
  publishPresence(
    target: PlaneTarget,
    room: RoomRef,
    payload?: PresencePayload,
    visible?: boolean,
  ): void {
    if (visible !== undefined) {
      // The reserved `visible` field is CONNECTION-level, not room-scoped
      // (D9.5): the notification router must be able to ask "is this user
      // watching?" for a connection that has joined no room at all, which is
      // exactly what today's `{ type: 'presence', visible }` frame reports.
      this.visibleByConnection.set(target.subscriberId, visible)
      this.principalOfConnection.set(target.subscriberId, target.principal)
    }
    const key = roomRoutingKey(room)
    if (!this.registry.has(key, target.subscriberId)) return
    if (payload !== undefined && !presencePayloadWithinBudget(payload)) return

    const memberId = principalRoutingId(target.principal)
    const members = this.memberMap(key)
    const state = members.get(memberId) ?? { identity: this.deps.identityOf(target.principal) }
    if (payload !== undefined) state.payload = payload
    if (visible !== undefined) state.visible = visible
    members.set(memberId, state)
    this.fanOut(key, room, 'updated', memberId)
  }

  occupancy(room: RoomRef): readonly PresenceMember[] {
    return this.snapshot(roomRoutingKey(room))
  }

  /**
   * Connection closed (or reaped by the existing 15s heartbeat sweep — no
   * presence-specific timer). Leaves are DERIVED here, which is the only
   * mechanism that cannot leak a ghost occupant (D10.6).
   */
  disconnect(subscriberId: SubscriberId): void {
    const keys = this.router.forget(subscriberId)
    for (const key of keys) this.settleAfterLeave(subscriberId, key)
    this.visibleByConnection.delete(subscriberId)
    this.principalOfConnection.delete(subscriberId)
  }

  setVisible(target: PlaneTarget, visible: boolean): void {
    this.visibleByConnection.set(target.subscriberId, visible)
    this.principalOfConnection.set(target.subscriberId, target.principal)
  }

  /**
   * D9.5's correctness fix for a SHIPPED feature: the notification router must
   * ask "is THIS user watching?", which today's anonymous OR across connections
   * cannot answer. The old bit maps forward as a field on the presence record
   * rather than surviving as a parallel frame.
   */
  isWatchedBy(principal: Principal): boolean {
    const wanted = principalRoutingId(principal)
    for (const [subscriberId, visible] of this.visibleByConnection) {
      if (!visible) continue
      const p = this.principalOfConnection.get(subscriberId)
      if (p && principalRoutingId(p) === wanted) return true
    }
    return false
  }

  /**
   * Visibility lost while subscribed: evict and stop the fan-out (D14.4). The
   * stream-plane sibling of `rescope`, and deliberately not the same frame — this
   * one repairs nothing, it only stops a fan-out.
   */
  evict(target: PlaneTarget, room: RoomRef): void {
    const key = roomRoutingKey(room)
    if (this.registry.has(key, target.subscriberId)) {
      this.leaveKey(target.subscriberId, key, room)
    }
    this.deps.emit(target.subscriberId, { type: 'presenceRoomClosed', room })
  }

  private leaveKey(subscriberId: SubscriberId, key: RoutingKey, room: RoomRef): void {
    if (!this.registry.unsubscribe(key, subscriberId)) return
    this.settleAfterLeave(subscriberId, key, room)
  }

  private settleAfterLeave(subscriberId: SubscriberId, key: RoutingKey, room?: RoomRef): void {
    const principal = this.principalOfConnection.get(subscriberId)
    if (!principal) return
    const memberId = principalRoutingId(principal)
    // The member leaves only when its LAST connection leaves (D9.4/D10.6).
    const stillHere = this.registry
      .subscribers(key)
      .some((s) => principalRoutingId(s.principal) === memberId)
    if (stillHere) return
    const members = this.rooms.get(key)
    const state = members?.get(memberId)
    members?.delete(memberId)
    if (members && members.size === 0) this.rooms.delete(key)
    const ref = room ?? roomKeyToRef(key)
    if (!ref || !state) return
    const outcome = this.router.publish(key, {
      type: 'presenceRoomDelta',
      room: ref,
      change: 'left',
      member: { identity: state.identity, payload: state.payload, visible: state.visible },
    })
    this.settleEvictions(outcome.evicted, key, ref)
  }

  private fanOut(
    key: RoutingKey,
    room: RoomRef,
    change: 'joined' | 'updated',
    memberId: string,
  ): void {
    const state = this.rooms.get(key)?.get(memberId)
    if (!state) return
    const outcome = this.router.publish(key, {
      type: 'presenceRoomDelta',
      room,
      change,
      member: { identity: state.identity, payload: state.payload, visible: state.visible },
    })
    this.settleEvictions(outcome.evicted, key, room)
  }

  private settleEvictions(
    subscribers: readonly SubscriberId[],
    key: RoutingKey,
    room: RoomRef,
  ): void {
    for (const subscriberId of subscribers) {
      this.settleAfterLeave(subscriberId, key, room)
      this.deps.emit(subscriberId, { type: 'presenceRoomClosed', room })
    }
  }

  private memberMap(key: RoutingKey): Map<string, MemberState> {
    let members = this.rooms.get(key)
    if (!members) {
      members = new Map()
      this.rooms.set(key, members)
    }
    return members
  }

  private snapshot(key: RoutingKey): readonly PresenceMember[] {
    return [...(this.rooms.get(key)?.values() ?? [])].map((s) => ({
      identity: s.identity,
      payload: s.payload,
      visible: s.visible,
    }))
  }
}

/**
 * Coalescing identity for room fan-out: LATEST-WINS PER MEMBER is the only
 * ordering obligation the stream plane accepts (D11.3).
 */
export const presenceCoalesceKey = (frame: PresenceRoomServerMessage): string => {
  switch (frame.type) {
    case 'presenceRoomDelta':
      return `${frame.room.kind}:${frame.room.id}:${identityKey(frame.member.identity)}:${frame.change === 'left' ? 'left' : 'state'}`
    case 'presenceRoomState':
      return `${frame.room.kind}:${frame.room.id}:snapshot`
    case 'presenceRoomClosed':
      return `${frame.room.kind}:${frame.room.id}:closed`
  }
}

const identityKey = (identity: PresenceIdentity): string =>
  identity.kind === 'user' ? `user:${identity.user}` : `agent:${identity.agentIdentity}`

/** Inverse of {@link roomRoutingKey} for the derived-leave path. */
const roomKeyToRef = (key: RoutingKey): RoomRef | null => {
  const [ns, kind, ...rest] = key.split(':')
  if (ns !== 'room' || rest.length === 0) return null
  if (kind !== 'session' && kind !== 'issue') return null
  return { kind, id: rest.join(':') } as RoomRef
}
