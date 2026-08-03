/**
 * THE PRESENCE SEAM APPS READ (POD-1535).
 *
 * Apps join rooms through here and nowhere else: `hub.subscribeRoom` is a
 * transport primitive with no refcount and no fold, and a component that
 * reached past this hook would own both. The fold, the refcount and the
 * ephemerality discipline live in `presence/room-presence.ts`; this file is the
 * React binding over it, in the shape `useSlice` established.
 *
 * PRESENCE IS NOT A SLICE. It never enters the slice publisher, a memoized
 * entity slice, the funnel, the oplog or a persisted snapshot — it is
 * stream-plane and blank when the connection is not there. That is why it has
 * its own hook rather than a `SliceDefinition`.
 */

import type { PresencePayload, RoomRef } from '@podium/protocol'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  type PresenceRooms,
  type PresenceRoomView,
  presenceRoomsFor,
  UNKNOWN_PRESENCE,
} from '../presence/room-presence'
import { useStoreSelector } from './provider'

export type { PresenceRoomView } from '../presence/room-presence'

/**
 * Watch a room's occupancy.
 *
 * A `null` room joins nothing and reads `unknown` — the shape a component uses
 * before its entity id exists. `payload` is this connection's own presence
 * payload; it is sent at join and republished whenever it changes.
 */
export function usePresenceRoom(
  room: RoomRef | null,
  payload?: PresencePayload,
): PresenceRoomView {
  const hub = useStoreSelector((s) => s.hub)
  const rooms = useMemo<PresenceRooms | null>(() => (hub ? presenceRoomsFor(hub) : null), [hub])

  // Rooms are compared by VALUE, not object identity: `{kind, id}` is rebuilt
  // every render at every call site, and re-joining a room on each render would
  // make presence flicker rather than work.
  const kind = room?.kind ?? null
  const id = room?.id ?? null
  const stableRoom = useMemo<RoomRef | null>(
    () => (kind && id ? ({ kind, id } as RoomRef) : null),
    [kind, id],
  )

  // The join payload is read at subscribe time only; later changes go through
  // the publish effect below. Held in a ref so a changing payload does not
  // re-subscribe.
  const joinPayload = useRef(payload)
  joinPayload.current = payload

  // What this connection has already told the room. `hub.subscribeRoom` sends
  // the join payload itself, so the join seeds this — otherwise every mount
  // would publish a duplicate of the frame it just sent.
  const sentPayload = useRef<string | undefined>(undefined)

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!rooms || !stableRoom) return () => {}
      sentPayload.current =
        joinPayload.current === undefined ? undefined : JSON.stringify(joinPayload.current)
      return rooms.subscribe(stableRoom, onChange, joinPayload.current)
    },
    [rooms, stableRoom],
  )

  const getSnapshot = useCallback(
    () => (rooms && stableRoom ? rooms.view(stableRoom) : UNKNOWN_PRESENCE),
    [rooms, stableRoom],
  )

  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Republish when this connection's own payload changes. Compared by
  // serialized value: the payload is a fresh literal on most renders, and the
  // port's rate cap is a discard, not a queue — so a needless publish is a
  // dropped frame someone else's update might have used.
  useEffect(() => {
    if (!rooms || !stableRoom || payload === undefined) return
    const encoded = JSON.stringify(payload)
    if (encoded === sentPayload.current) return
    sentPayload.current = encoded
    rooms.publish(stableRoom, payload)
  }, [rooms, stableRoom, payload])

  return view
}
