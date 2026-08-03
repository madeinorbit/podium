// @vitest-environment happy-dom
/**
 * POD-1535 — the presence SEAM under real React renders.
 *
 * `room-presence.test.ts` proves the fold. It cannot prove the BINDING: a
 * perfect fold is invisible if the hook never subscribes, re-subscribes on
 * every render (presence flickers), or never re-renders on a delta. So these
 * drive real renders and count the joins.
 *
 * The probe says YES before it is trusted — the first assertion is that the
 * hook joined the room at all.
 */
import type { SessionId } from '@podium/model'
import type { PresenceMember, PresencePayload, RoomRef } from '@podium/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PresenceHubPort } from '../presence/room-presence'
import type { HubEvents } from '../socket-transport'

const ALICE: PresenceMember = { identity: { kind: 'user', user: 'user:alice' as never } }

class FakeHub implements PresenceHubPort {
  connected = true
  readonly joins: RoomRef[] = []
  readonly leaves: RoomRef[] = []
  readonly published: PresencePayload[] = []
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

  publishPresence(_room: RoomRef, payload: PresencePayload): boolean {
    this.published.push(payload)
    return true
  }

  emit<K extends keyof HubEvents>(kind: K, ...payload: HubEvents[K]): void {
    for (const handler of this.handlers.get(kind) ?? []) {
      ;(handler as (...args: HubEvents[K]) => void)(...payload)
    }
  }
}

let hub = new FakeHub()

// The hook reads the hub off the store. Only that read is mocked: the
// registry, the fold and the refcount under test are the real ones.
vi.mock('./provider', () => ({
  useStoreSelector: (select: (s: { hub: FakeHub }) => unknown) => select({ hub }),
}))

const { usePresenceRoom } = await import('./use-presence-room')

const ROOM = { kind: 'session', id: 's_1' as SessionId } as RoomRef

function Watchers({ room, view }: { room: RoomRef | null; view?: string }): JSX.Element {
  const presence = usePresenceRoom(room, view === undefined ? undefined : { view })
  return (
    <div data-testid="out" data-status={presence.status}>
      {presence.status === 'present' ? presence.members.length : 'unknown'}
    </div>
  )
}

afterEach(() => {
  cleanup()
  hub = new FakeHub()
})

const out = () => screen.getByTestId('out')

describe('usePresenceRoom', () => {
  it('joins on mount, renders the snapshot, and leaves on unmount', () => {
    const view = render(<Watchers room={ROOM} />)
    expect(hub.joins).toEqual([ROOM])
    expect(out().dataset.status).toBe('unknown')

    act(() => {
      hub.emit('presenceRoomState', { type: 'presenceRoomState', room: ROOM, members: [ALICE] })
    })
    expect(out().dataset.status).toBe('present')
    expect(out().textContent).toBe('1')

    view.unmount()
    expect(hub.leaves).toEqual([ROOM])
  })

  it('does not re-join when the room literal is rebuilt with the same value', () => {
    const view = render(<Watchers room={{ ...ROOM }} />)
    expect(hub.joins).toHaveLength(1)
    view.rerender(<Watchers room={{ ...ROOM }} />)
    view.rerender(<Watchers room={{ ...ROOM }} />)
    expect(hub.joins).toHaveLength(1)
  })

  it('joins nothing and reads unknown for a null room', () => {
    render(<Watchers room={null} />)
    expect(hub.joins).toEqual([])
    expect(out().dataset.status).toBe('unknown')
  })

  it('publishes its own payload once per distinct value', () => {
    const view = render(<Watchers room={ROOM} view="chat" />)
    view.rerender(<Watchers room={ROOM} view="chat" />)
    expect(hub.published).toEqual([])

    view.rerender(<Watchers room={ROOM} view="native" />)
    expect(hub.published).toEqual([{ view: 'native' }])
  })

  it('re-renders as unknown when the room closes', () => {
    render(<Watchers room={ROOM} />)
    act(() => {
      hub.emit('presenceRoomState', { type: 'presenceRoomState', room: ROOM, members: [ALICE] })
    })
    expect(out().dataset.status).toBe('present')
    act(() => {
      hub.emit('presenceRoomClosed', { type: 'presenceRoomClosed', room: ROOM })
    })
    expect(out().dataset.status).toBe('unknown')
  })
})
