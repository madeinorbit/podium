/**
 * The fold, the refcount, and THE invariant: a room whose occupancy we do not
 * know must not be readable as an empty room.
 */

import type { IssueId, SessionId } from '@podium/model'
import type { PresenceMember, PresencePayload, RoomRef } from '@podium/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubEvents } from '../socket-transport'
import { PresenceRooms, type PresenceHubPort } from './room-presence'

const SESSION = { kind: 'session', id: 's_1' as SessionId } as RoomRef
const OTHER = { kind: 'issue', id: 'i_1' as IssueId } as RoomRef

const ALICE: PresenceMember = { identity: { kind: 'user', user: 'user:alice' as never } }
const BOB: PresenceMember = { identity: { kind: 'user', user: 'user:bob' as never } }

class FakeHub implements PresenceHubPort {
  connected = true
  readonly joins: RoomRef[] = []
  readonly leaves: RoomRef[] = []
  readonly published: { room: RoomRef; payload: PresencePayload }[] = []
  private handlers = new Map<string, Set<unknown>>()

  on<K extends keyof HubEvents>(kind: K, handler: (...payload: HubEvents[K]) => void): () => void {
    const set = this.handlers.get(kind) ?? new Set<unknown>()
    this.handlers.set(kind, set)
    set.add(handler)
    return () => set.delete(handler)
  }

  subscribeRoom(room: RoomRef): () => void {
    this.joins.push(room)
    return () => {
      this.leaves.push(room)
    }
  }

  publishPresence(room: RoomRef, payload: PresencePayload): boolean {
    this.published.push({ room, payload })
    return true
  }

  /** Drive a server frame, exactly as the hub would. */
  emit<K extends keyof HubEvents>(kind: K, ...payload: HubEvents[K]): void {
    for (const handler of this.handlers.get(kind) ?? []) {
      ;(handler as (...args: HubEvents[K]) => void)(...payload)
    }
  }

  listenerCount(kind: keyof HubEvents): number {
    return this.handlers.get(kind)?.size ?? 0
  }
}

let hub: FakeHub
let rooms: PresenceRooms

beforeEach(() => {
  hub = new FakeHub()
  rooms = new PresenceRooms(hub)
})

const state = (room: RoomRef, members: PresenceMember[]) =>
  hub.emit('presenceRoomState', { type: 'presenceRoomState', room, members })

describe('PresenceRooms', () => {
  it('reads unknown — with no member list at all — until the server answers', () => {
    const view = rooms.view(SESSION)
    expect(view.status).toBe('unknown')
    // THE INVARIANT: there is nothing to map over, so no caller can render
    // "nobody is here" from a state that only means "we do not know".
    expect(view.members).toBeUndefined()
  })

  it('folds the join snapshot into present, and an empty room is a KNOWN empty room', () => {
    rooms.subscribe(SESSION, () => {})
    state(SESSION, [])
    const view = rooms.view(SESSION)
    expect(view.status).toBe('present')
    expect(view.members).toEqual([])
  })

  it('applies joined / updated / left deltas over the snapshot', () => {
    rooms.subscribe(SESSION, () => {})
    state(SESSION, [ALICE])

    hub.emit('presenceRoomDelta', {
      type: 'presenceRoomDelta',
      room: SESSION,
      change: 'joined',
      member: BOB,
    })
    expect(rooms.view(SESSION).members).toHaveLength(2)

    hub.emit('presenceRoomDelta', {
      type: 'presenceRoomDelta',
      room: SESSION,
      change: 'updated',
      member: { ...BOB, payload: { view: 'chat' } },
    })
    expect(rooms.view(SESSION).members).toHaveLength(2)
    expect(rooms.view(SESSION).members?.find((m) => m.identity === BOB.identity)?.payload).toEqual({
      view: 'chat',
    })

    hub.emit('presenceRoomDelta', {
      type: 'presenceRoomDelta',
      room: SESSION,
      change: 'left',
      member: ALICE,
    })
    expect(rooms.view(SESSION).members?.map((m) => m.identity)).toEqual([BOB.identity])
  })

  it('ignores a delta that arrives before the snapshot rather than building a partial room', () => {
    rooms.subscribe(SESSION, () => {})
    hub.emit('presenceRoomDelta', {
      type: 'presenceRoomDelta',
      room: SESSION,
      change: 'joined',
      member: ALICE,
    })
    expect(rooms.view(SESSION).status).toBe('unknown')
  })

  it('reverts to unknown — not to empty — when the room closes', () => {
    rooms.subscribe(SESSION, () => {})
    state(SESSION, [ALICE, BOB])
    hub.emit('presenceRoomClosed', { type: 'presenceRoomClosed', room: SESSION })
    const view = rooms.view(SESSION)
    expect(view.status).toBe('unknown')
    expect(view.members).toBeUndefined()
  })

  it('reverts to unknown when the connection drops, and does not treat it as everyone leaving', () => {
    rooms.subscribe(SESSION, () => {})
    state(SESSION, [ALICE])
    hub.connected = false
    hub.emit('connectionHealth', { status: 'offline', rttMs: null, since: 0 } as never)
    expect(rooms.view(SESSION).status).toBe('unknown')
    expect(rooms.view(SESSION).members).toBeUndefined()
    // The room subscription is retained: the hub restores it on reconnect and
    // the server answers with a fresh snapshot.
    expect(hub.leaves).toEqual([])
  })

  it('joins a room once for many watchers and leaves when the last one releases', () => {
    const first = rooms.subscribe(SESSION, () => {})
    const second = rooms.subscribe(SESSION, () => {})
    expect(hub.joins).toEqual([SESSION])

    first()
    expect(hub.leaves).toEqual([])
    second()
    expect(hub.leaves).toEqual([SESSION])
  })

  it('is idempotent on a repeated release', () => {
    const release = rooms.subscribe(SESSION, () => {})
    release()
    release()
    expect(hub.leaves).toHaveLength(1)
  })

  it('notifies only the listeners of the room the frame names', () => {
    const onSession = vi.fn()
    const onOther = vi.fn()
    rooms.subscribe(SESSION, onSession)
    rooms.subscribe(OTHER, onOther)
    state(SESSION, [ALICE])
    expect(onSession).toHaveBeenCalledTimes(1)
    expect(onOther).not.toHaveBeenCalled()
  })

  it('returns a stable snapshot object while nothing changes', () => {
    rooms.subscribe(SESSION, () => {})
    state(SESSION, [ALICE])
    expect(rooms.view(SESSION)).toBe(rooms.view(SESSION))
  })

  it('detaches its hub listeners when the last room goes, and re-attaches for a new one', () => {
    const release = rooms.subscribe(SESSION, () => {})
    expect(hub.listenerCount('presenceRoomState')).toBe(1)
    release()
    expect(hub.listenerCount('presenceRoomState')).toBe(0)
    rooms.subscribe(SESSION, () => {})
    expect(hub.listenerCount('presenceRoomState')).toBe(1)
  })

  it('publishes only into a joined room', () => {
    expect(rooms.publish(SESSION, { view: 'chat' })).toBe(false)
    rooms.subscribe(SESSION, () => {})
    expect(rooms.publish(SESSION, { view: 'chat' })).toBe(true)
    expect(hub.published).toEqual([{ room: SESSION, payload: { view: 'chat' } }])
  })
})
