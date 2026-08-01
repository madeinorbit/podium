import {
  type PresencePayload,
  type PresenceRoomClientMessage,
  type RoomRef,
  type RoutingKey,
  roomRoutingKey,
} from '@podium/protocol'

export type ClientSubscriptionDurability = 'durable' | 'ephemeral'

export interface ClientSubscription {
  readonly key: RoutingKey
  readonly durability: ClientSubscriptionDurability
  readonly room?: RoomRef
  readonly payload?: PresencePayload
  readonly visible?: boolean
}

const FEED_KEY = 'principal:authenticated' as RoutingKey

const sameRoom = (left: RoomRef, right: RoomRef): boolean =>
  left.kind === right.kind && left.id === right.id

/**
 * The one client-side subscription registry.
 *
 * Feed routing and presence rooms share this table and differ only by
 * durability. The authenticated principal is intentionally absent: the socket
 * establishes it, and a principal-derived value cached here could survive a
 * sign-out or user switch.
 */
export class ClientSubscriptionRegistry {
  private readonly subscriptions = new Map<RoutingKey, ClientSubscription>()

  constructor(feedEnabled: boolean) {
    if (feedEnabled) {
      this.subscriptions.set(FEED_KEY, {
        key: FEED_KEY,
        durability: 'durable',
      })
    }
  }

  subscribeRoom(room: RoomRef, payload?: PresencePayload, visible?: boolean): boolean {
    const key = roomRoutingKey(room)
    const fresh = !this.subscriptions.has(key)
    this.subscriptions.set(key, {
      key,
      durability: 'ephemeral',
      room,
      ...(payload !== undefined ? { payload } : {}),
      ...(visible !== undefined ? { visible } : {}),
    })
    return fresh
  }

  unsubscribeRoom(room: RoomRef): boolean {
    return this.subscriptions.delete(roomRoutingKey(room))
  }

  updateRoom(room: RoomRef, payload?: PresencePayload, visible?: boolean): boolean {
    const key = roomRoutingKey(room)
    const current = this.subscriptions.get(key)
    if (current?.room === undefined) return false
    this.subscriptions.set(key, {
      ...current,
      ...(payload !== undefined ? { payload } : {}),
      ...(visible !== undefined ? { visible } : {}),
    })
    return true
  }

  updateVisibility(visible: boolean): void {
    for (const [key, current] of this.subscriptions) {
      if (current.room !== undefined) this.subscriptions.set(key, { ...current, visible })
    }
  }

  room(room: RoomRef): ClientSubscription | undefined {
    const current = this.subscriptions.get(roomRoutingKey(room))
    return current?.room !== undefined && sameRoom(current.room, room) ? current : undefined
  }

  reconnectFrames(): PresenceRoomClientMessage[] {
    const frames: PresenceRoomClientMessage[] = []
    for (const subscription of this.subscriptions.values()) {
      if (subscription.durability !== 'ephemeral' || subscription.room === undefined) continue
      frames.push({ type: 'presenceSubscribe', room: subscription.room })
      if (subscription.payload !== undefined || subscription.visible !== undefined) {
        frames.push({
          type: 'presenceUpdate',
          room: subscription.room,
          ...(subscription.payload !== undefined ? { payload: subscription.payload } : {}),
          ...(subscription.visible !== undefined ? { visible: subscription.visible } : {}),
        })
      }
    }
    return frames
  }

  snapshot(): readonly ClientSubscription[] {
    return [...this.subscriptions.values()]
  }

  clearForPrincipalChange(): void {
    this.subscriptions.clear()
  }
}
