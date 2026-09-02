/**
 * THE POSITION A CONNECTION PRESENTS, AND WHAT IT BUYS (POD-2061).
 *
 * Two facts about this hub, and they are the whole client half of the change:
 * the `hello` it sends carries whatever the sink handed it, unread; and the sink
 * is told whether that purchased a world. Everything else — which cursor, when
 * to resume, what to do with the answer — belongs to the replica side, and the
 * transport-ownership boundary test asserts that it stays there.
 */

import { describe, expect, it, vi } from 'vitest'
import type { FeedHelloFields, FeedSinkPort, WebSocketLike } from './index'
import { SocketHub } from './socket-hub'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  hello(): Record<string, unknown> | undefined {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((msg) => msg.type === 'hello')
  }
}

const POSITION: FeedHelloFields = {
  feedCursor: { feedId: 'feed_1', epoch: 'epoch_1', seq: 42 },
}

function setup(fields: () => FeedHelloFields | null) {
  const sockets: FakeSocket[] = []
  const promised: boolean[] = []
  const feed: FeedSinkPort = {
    helloFields: fields,
    connected: (worldPromised) => promised.push(worldPromised),
    disconnected: () => {},
    frame: () => {},
  }
  const hub = new SocketHub({
    url: 'ws://x',
    makeSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    feed,
  })
  return { hub, sockets, promised }
}

describe('a reconnecting hub presents the replica position', () => {
  it('carries the sink fields in hello and reports no promised world', () => {
    const { hub, sockets, promised } = setup(() => POSITION)
    hub.connect()
    sockets[0]?.open()

    expect(sockets[0]?.hello()).toMatchObject({ feedCursor: POSITION.feedCursor })
    expect(promised).toEqual([false])
  })

  it('omits the field entirely when the replica holds nothing to resume from', () => {
    const { hub, sockets, promised } = setup(() => null)
    hub.connect()
    sockets[0]?.open()

    // ABSENT, not null: the pre-POD-2061 `hello` byte for byte, which is what an
    // older server (and every wire-v1 peer) reads as "serve me the world".
    expect(sockets[0]?.hello()).not.toHaveProperty('feedCursor')
    expect(promised).toEqual([true])
  })

  it('does not present a position on the socket a re-bootstrap asked for', () => {
    vi.useFakeTimers()
    try {
      const { hub, sockets, promised } = setup(() => POSITION)
      hub.connect()
      sockets[0]?.open()
      expect(promised).toEqual([false])

      // The walk asks for a world; the transport delivers one by cycling the
      // socket. Presenting the cursor on the replacement would earn a resume
      // grant — and the walk waiting for that world would time out.
      hub.requestFreshWorld()
      vi.advanceTimersByTime(1_000)
      sockets[1]?.open()

      expect(sockets[1]?.hello()).not.toHaveProperty('feedCursor')
      expect(promised).toEqual([false, true])

      // AND THE LATCH IS SPENT. The next drop is an ordinary one, so the next
      // connection resumes again rather than paying for a world nobody asked for.
      sockets[1]?.close()
      vi.advanceTimersByTime(1_000)
      sockets[2]?.open()

      expect(sockets[2]?.hello()).toMatchObject({ feedCursor: POSITION.feedCursor })
      expect(promised).toEqual([false, true, false])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the position once per connection', () => {
    const fields = vi.fn(() => POSITION)
    const { hub, sockets } = setup(fields)
    hub.connect()
    sockets[0]?.open()

    // Twice would be two answers to "where does this replica stand" inside one
    // admission, and the second could differ — the value is read from a live
    // replica whose heal may land between the two calls.
    expect(fields).toHaveBeenCalledTimes(1)
  })
})
