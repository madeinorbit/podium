import {
  isNewerTopicPosition,
  type PresencePayload,
  type PresenceRoomClientMessage,
  type RoomRef,
  type RoutingKey,
  roomRoutingKey,
  type TopicClientMessage,
  type TopicClosedReason,
  type TopicKey,
  type TopicKind,
  type TopicPayload,
  type TopicPosition,
  topicDeclaration,
  topicKey,
  topicRoutingKey,
} from '@podium/protocol'

export type ClientSubscriptionDurability = 'durable' | 'ephemeral'

/**
 * What a topic holder sees (ADR 7 Amendment 2 D20).
 *
 * - `pending`: subscribed, no snapshot yet. A fresh client shows this as
 *   unknown too; it is never a stale value.
 * - `value`: the server's current value at `position`.
 * - `unknown`: the server said unknown, or the connection was declared lost;
 *   `last` is the newest value held before that, for "last seen", and `since`
 *   when it went unknown.
 * - `closed`: the server ended the subscription (refused, revoked, …). It is
 *   asked again after the next reconnect.
 */
export type TopicState<P = unknown> =
  | { readonly status: 'pending' }
  | { readonly status: 'value'; readonly value: P; readonly position: TopicPosition }
  | { readonly status: 'unknown'; readonly last?: P; readonly since: number }
  | { readonly status: 'closed'; readonly reason: TopicClosedReason; readonly last?: P }

export interface TopicListener<P = unknown> {
  /** Value kinds: every state change, starting with the current state. */
  readonly onState?: (state: TopicState<P>) => void
  /** Event kinds: one notice. */
  readonly onEvent?: (payload: P) => void
}

/** One held topic key: its holders and what the server last said about it. */
export interface TopicEntry {
  readonly key: TopicKey
  readonly kind: TopicKind
  readonly id: string
  readonly listeners: Set<TopicListener>
  state: TopicState
  /** The newest position applied; a log resubscribes from here. */
  position?: TopicPosition
}

export interface ClientSubscription {
  readonly key: RoutingKey
  readonly durability: ClientSubscriptionDurability
  readonly room?: RoomRef
  readonly payload?: PresencePayload
  readonly visible?: boolean
  readonly topic?: TopicEntry
}

const FEED_KEY = 'principal:authenticated' as RoutingKey

const sameRoom = (left: RoomRef, right: RoomRef): boolean =>
  left.kind === right.kind && left.id === right.id

const lastValue = (state: TopicState): unknown =>
  state.status === 'value' ? state.value : state.status === 'pending' ? undefined : state.last

/**
 * The one client-side subscription registry.
 *
 * Feed routing, presence rooms and topics share this table and differ only by
 * durability. Topics are REFERENCE-COUNTED per key per runtime (D20): two views
 * on one key are two listeners on one entry and one server subscription. The
 * authenticated principal is intentionally absent: the socket establishes it,
 * and a principal-derived value cached here could survive a sign-out or user
 * switch.
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

  // -------------------------------------------------------------------------
  // Topics (ADR 7 Amendment 2 D20)
  // -------------------------------------------------------------------------

  /**
   * Add one holder. `fresh` is true for the key's FIRST holder: the caller then
   * sends `topicSubscribe`. A later holder shares the entry and its state.
   */
  acquireTopic(
    kind: TopicKind,
    id: string,
    listener: TopicListener,
  ): { fresh: boolean; entry: TopicEntry } {
    const routing = topicRoutingKey({ kind, id })
    const current = this.subscriptions.get(routing)?.topic
    if (current) {
      current.listeners.add(listener)
      return { fresh: false, entry: current }
    }
    const entry: TopicEntry = {
      key: topicKey(kind, id),
      kind,
      id,
      listeners: new Set([listener]),
      state: { status: 'pending' },
    }
    this.subscriptions.set(routing, { key: routing, durability: 'ephemeral', topic: entry })
    return { fresh: true, entry }
  }

  /** Remove one holder. True when it was the LAST: the caller sends `topicUnsubscribe`. */
  releaseTopic(kind: TopicKind, id: string, listener: TopicListener): boolean {
    const routing = topicRoutingKey({ kind, id })
    const entry = this.subscriptions.get(routing)?.topic
    if (!entry || !entry.listeners.delete(listener)) return false
    if (entry.listeners.size > 0) return false
    this.subscriptions.delete(routing)
    return true
  }

  /** The ids of `kind` this listener holds, read from the table itself. */
  topicIdsHeldBy(kind: TopicKind, listener: TopicListener): string[] {
    return this.topicEntries().flatMap((entry) =>
      entry.kind === kind && entry.listeners.has(listener) ? [entry.id] : [],
    )
  }

  topic(kind: TopicKind, id: string): TopicEntry | undefined {
    return this.subscriptions.get(topicRoutingKey({ kind, id }))?.topic
  }

  /**
   * A snapshot: always applied, it starts the position over (a new epoch
   * always arrives as one). An absent payload is the valid `unknown`.
   */
  applyTopicSnapshot(entry: TopicEntry, position: TopicPosition, payload: unknown): void {
    entry.position = position
    entry.state =
      payload === undefined
        ? { status: 'unknown', last: lastValue(entry.state), since: Date.now() }
        : { status: 'value', value: payload, position }
  }

  /** An update applies only if its position is newer in the same epoch (D19). */
  applyTopicUpdate(entry: TopicEntry, position: TopicPosition, payload: unknown): boolean {
    if (!isNewerTopicPosition(entry.position, position)) return false
    if (entry.position === undefined) return false
    this.applyTopicSnapshot(entry, position, payload)
    return true
  }

  closeTopic(entry: TopicEntry, reason: TopicClosedReason): void {
    entry.state = { status: 'closed', reason, last: lastValue(entry.state) }
  }

  /**
   * The connection was declared lost: every value becomes unknown, keeping the
   * last one for "last seen" (D20). Returns the entries that changed.
   */
  markTopicsUnknown(since: number): TopicEntry[] {
    const changed: TopicEntry[] = []
    for (const subscription of this.subscriptions.values()) {
      const entry = subscription.topic
      if (!entry || topicDeclaration(entry.kind).style !== 'value') continue
      if (entry.state.status === 'unknown') continue
      entry.state = { status: 'unknown', last: lastValue(entry.state), since }
      changed.push(entry)
    }
    return changed
  }

  topicEntries(): readonly TopicEntry[] {
    return [...this.subscriptions.values()].flatMap((s) => (s.topic ? [s.topic] : []))
  }

  /** Every held key, re-asked after a reconnect; a log from its last good position. */
  topicReconnectFrames(): TopicClientMessage[] {
    return this.topicEntries().map((entry) => ({
      type: 'topicSubscribe',
      key: entry.key,
      ...(topicDeclaration(entry.kind).style === 'log' && entry.position
        ? { from: entry.position }
        : {}),
    }))
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

/** Typed view of a held topic's state, for one kind. */
export type TopicStateOf<K extends TopicKind> = TopicState<TopicPayload<K>>
