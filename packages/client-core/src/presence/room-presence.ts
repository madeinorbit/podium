/**
 * ROOM PRESENCE, AS A READABLE VIEW (POD-1535).
 *
 * ADR 7 Amendment 1's rooms landed with a transport and no consumer: the hub
 * can join a room and fan out identity-carrying frames, but nothing folded
 * those frames into something a component could render. This module is that
 * fold, and it is the ONLY place in the client that talks to
 * `hub.subscribeRoom` / `hub.publishPresence`.
 *
 * ---------------------------------------------------------------------------
 * "NOBODY IS HERE" AND "WE DO NOT KNOW" ARE DIFFERENT ANSWERS
 * ---------------------------------------------------------------------------
 *
 * Presence is stream · live: ephemeral, lossy, dropped rather than buffered.
 * The protocol answers every failure to join with ONE frame and no reason code
 * (`presenceRoomClosed`, D14.3 — a subscribe frame that answers differently is
 * an existence oracle with a polling interface). So the client's honest state
 * space has two members, and {@link PresenceRoomView} makes them structurally
 * un-confusable rather than a rule a component must remember:
 *
 *   - `unknown` — not joined yet, join refused, visibility lost, evicted, or
 *     disconnected. There is NO `members` array to read, so no caller can map
 *     over an empty list and paint "alone".
 *   - `present` — the server told us the occupancy. `members: []` then means
 *     genuinely only-you, which is a fact and may be stated as one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LAYER REFCOUNTS
 * ---------------------------------------------------------------------------
 *
 * `ClientSubscriptionRegistry` is a MAP keyed by routing key, deliberately: a
 * room is one subscription per connection, not per caller. Two components
 * watching the same session would therefore have one of them release the room
 * out from under the other on unmount. Refcounting belongs here — above the
 * registry, where callers are — and not in the registry, whose one-entry-per-
 * room shape is what makes the reconnect restore total.
 *
 * NOTHING HERE IS DURABLE. No persistence, no entity slice, no oplog, no
 * snapshot. The registry is held in a `WeakMap` keyed on the hub, so it dies
 * with the runtime — and a runtime is per principal, which is what makes "one
 * person's presence cannot survive into another's session" structural.
 */

import type { PresenceMember, PresencePayload, RoomRef } from '@podium/protocol'
import type { HubEvents, SocketHub } from '../socket-transport'

/**
 * What a room looks like right now. See the header: the absence of `members`
 * on the `unknown` arm is the invariant, not a convenience.
 */
export type PresenceRoomView =
  | { readonly status: 'unknown'; readonly members?: undefined }
  | { readonly status: 'present'; readonly members: readonly PresenceMember[] }

/** The one shared `unknown` value, so an unjoined room's snapshot is stable. */
export const UNKNOWN_PRESENCE: PresenceRoomView = Object.freeze({ status: 'unknown' as const })

/**
 * The slice of {@link SocketHub} this module uses. Named so tests drive a fake
 * without standing up a socket, and so the coupling is one visible list rather
 * than the whole hub.
 */
export type PresenceHubEventKind =
  | 'presenceRoomState'
  | 'presenceRoomDelta'
  | 'presenceRoomClosed'
  | 'connectionHealth'

export interface PresenceHubPort {
  readonly connected: boolean
  on<K extends PresenceHubEventKind>(
    kind: K,
    handler: (...payload: HubEvents[K]) => void,
  ): () => void
  subscribeRoom(room: RoomRef, payload?: PresencePayload): () => void
  publishPresence(room: RoomRef, payload: PresencePayload): boolean
}

/** Stable key for a room reference. Rooms are entity references (D10.2). */
export const roomKey = (room: RoomRef): string => `${room.kind}:${room.id}`

/**
 * Stable key for a presence identity. The agent arm carries ADR 3 D17's
 * attribution pair, so both halves are part of the key — two agents acting for
 * the same person are two members.
 */
export const presenceIdentityKey = (member: PresenceMember): string =>
  member.identity.kind === 'user'
    ? `u:${member.identity.user}`
    : `a:${member.identity.agentIdentity}@${member.identity.onBehalfOf}`

interface RoomEntry {
  readonly room: RoomRef
  readonly listeners: Set<() => void>
  members: Map<string, PresenceMember>
  view: PresenceRoomView
  release: (() => void) | null
  payload: PresencePayload
}

export class PresenceRooms {
  private readonly entries = new Map<string, RoomEntry>()
  private hubListeners: (() => void)[] = []

  constructor(private readonly hub: PresenceHubPort) {}

  /** The current fold for a room. Snapshot-stable: equal states share an object. */
  view(room: RoomRef): PresenceRoomView {
    return this.entries.get(roomKey(room))?.view ?? UNKNOWN_PRESENCE
  }

  /**
   * Watch a room. The first watcher joins it; the last one to release leaves.
   * `payload` is this connection's own presence payload at join time.
   */
  subscribe(room: RoomRef, listener: () => void, payload?: PresencePayload): () => void {
    const key = roomKey(room)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = {
        room,
        listeners: new Set(),
        members: new Map(),
        view: UNKNOWN_PRESENCE,
        release: null,
        payload,
      }
      this.entries.set(key, entry)
      this.attachHubListeners()
      entry.release = this.hub.subscribeRoom(room, payload)
    } else if (payload !== undefined) {
      entry.payload = payload
    }
    entry.listeners.add(listener)

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.entries.get(key)
      if (current === undefined) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      current.release?.()
      this.entries.delete(key)
      if (this.entries.size === 0) this.detachHubListeners()
    }
  }

  /**
   * Publish this connection's payload into a joined room. Returns false when
   * the room is not joined or the hub refused it (over budget, disconnected) —
   * a refused presence update is corrected by the next one, never retried or
   * truncated here.
   */
  publish(room: RoomRef, payload: PresencePayload): boolean {
    const entry = this.entries.get(roomKey(room))
    if (entry === undefined) return false
    entry.payload = payload
    return this.hub.publishPresence(room, payload)
  }

  private attachHubListeners(): void {
    if (this.hubListeners.length > 0) return
    this.hubListeners = [
      this.hub.on('presenceRoomState', (frame) => {
        const entry = this.entries.get(roomKey(frame.room))
        if (entry === undefined) return
        entry.members = new Map(frame.members.map((m) => [presenceIdentityKey(m), m]))
        this.republish(entry)
      }),

      this.hub.on('presenceRoomDelta', (frame) => {
        const entry = this.entries.get(roomKey(frame.room))
        // A delta before the snapshot would build a partial occupancy that
        // READS authoritative. `unknown` stays unknown until the server says
        // who is there (D10.5 guarantees a snapshot on join, so this drops
        // nothing a later frame does not restate).
        if (entry === undefined || entry.view.status !== 'present') return
        const key = presenceIdentityKey(frame.member)
        if (frame.change === 'left') entry.members.delete(key)
        else entry.members.set(key, frame.member)
        this.republish(entry)
      }),

      this.hub.on('presenceRoomClosed', (frame) => {
        const entry = this.entries.get(roomKey(frame.room))
        if (entry === undefined) return
        this.forget(entry)
      }),

      // A dropped connection is not a departure: everyone we knew about may
      // still be there. The hub re-sends the room's presence frames on
      // reconnect, so the server answers with a fresh snapshot and the view
      // returns to `present` on its own.
      this.hub.on('connectionHealth', () => {
        if (this.hub.connected) return
        for (const entry of this.entries.values()) this.forget(entry)
      }),
    ]
  }

  private detachHubListeners(): void {
    for (const off of this.hubListeners) off()
    this.hubListeners = []
  }

  private forget(entry: RoomEntry): void {
    if (entry.view.status === 'unknown' && entry.members.size === 0) return
    entry.members.clear()
    entry.view = UNKNOWN_PRESENCE
    this.emit(entry)
  }

  private republish(entry: RoomEntry): void {
    entry.view = { status: 'present', members: [...entry.members.values()] }
    this.emit(entry)
  }

  private emit(entry: RoomEntry): void {
    for (const listener of entry.listeners) listener()
  }
}

/**
 * One registry per hub, weakly held: it goes away with the runtime that owns
 * the hub, and a runtime is constructed per principal. Nothing is "cleared" on
 * sign-out because nothing outlives the object graph the principal owns.
 */
const registries = new WeakMap<object, PresenceRooms>()

export function presenceRoomsFor(hub: SocketHub | PresenceHubPort): PresenceRooms {
  const existing = registries.get(hub as object)
  if (existing !== undefined) return existing
  const created = new PresenceRooms(hub as PresenceHubPort)
  registries.set(hub as object, created)
  return created
}
