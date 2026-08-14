import { describe, expect, it } from 'vitest'
import type { FeedServerFrame } from '../../socket-transport'
import { FeedSink } from './sink'

/** One `feedBootstrap` chunk, in the shape the sink translates. */
const bootstrapChunk = (seq: number): FeedServerFrame => ({
  type: 'feedBootstrap',
  feedId: 'feed_1',
  epoch: 'epoch_1',
  fromSeq: 0,
  seq,
  minAvailableSeq: 0,
  changes: [],
  last: true,
})

describe('FeedSink lifecycle', () => {
  it('marks the socket world as expected before starting the replica ladder', () => {
    const order: string[] = []
    const sink = new FeedSink({
      replica: {
        connect: () => order.push('replica.connect'),
        disconnect: () => {},
        receive: () => {},
      } as never,
      bootstraps: {
        expectWorld: () => order.push('bootstrap.expected'),
        isWalking: () => false,
      } as never,
    })

    sink.connected(true)

    expect(order).toEqual(['bootstrap.expected', 'replica.connect'])
  })

  it('promises no world on a connection that presented a cursor', () => {
    const order: string[] = []
    const sink = new FeedSink({
      replica: {
        connect: () => order.push('replica.connect'),
        disconnect: () => {},
        receive: () => {},
        cursor: null,
      } as never,
      bootstraps: {
        expectWorld: () => order.push('bootstrap.expected'),
        isWalking: () => false,
      } as never,
    })

    sink.connected(false)

    // The ladder still starts — from `stale` that is D7-1-RESUME, the heal. What
    // must NOT happen is arming a world nothing is going to send: the flag would
    // outlive this connection's admission and the next walk would wait it out.
    expect(order).toEqual(['replica.connect'])
  })

  it('arms the world the moment a refused cursor produces one', () => {
    const order: string[] = []
    const sink = new FeedSink({
      replica: {
        connect: () => order.push('replica.connect'),
        disconnect: () => {},
        receive: () => {},
        cursor: null,
      } as never,
      bootstraps: {
        expectWorld: () => order.push('bootstrap.expected'),
        isWalking: () => false,
        offer: () => order.push('bootstrap.offered'),
      } as never,
    })

    sink.connected(false)
    sink.frame(bootstrapChunk(7))

    // ARMED BEFORE OFFERED, so the slot records the world as one this connection
    // was owed — which is what lets the walk that STARTS LATER (the heal comes
    // back `bootstrap-required`) consume it instead of cycling the socket for a
    // world already in hand.
    expect(order).toEqual(['replica.connect', 'bootstrap.expected', 'bootstrap.offered'])
  })

  it('arms once per admission, not once per chunk', () => {
    let armed = 0
    const sink = new FeedSink({
      replica: {
        connect: () => {},
        disconnect: () => {},
        receive: () => {},
        cursor: null,
      } as never,
      bootstraps: {
        expectWorld: () => {
          armed += 1
        },
        isWalking: () => false,
        offer: () => {},
      } as never,
    })

    sink.connected(false)
    sink.frame(bootstrapChunk(7))
    sink.frame(bootstrapChunk(7))

    expect(armed).toBe(1)
  })

  it('does not arm a world after the server granted the resume', () => {
    let armed = 0
    const sink = new FeedSink({
      replica: {
        connect: () => {},
        disconnect: () => {},
        receive: () => {},
        cursor: { feedId: 'feed_1', epoch: 'epoch_1', seq: 4 },
      } as never,
      bootstraps: {
        expectWorld: () => {
          armed += 1
        },
        isWalking: () => false,
        offer: () => {},
      } as never,
    })

    sink.connected(false)
    sink.frame({ type: 'feedResume', feedId: 'feed_1', epoch: 'epoch_1', seq: 4 })
    sink.frame(bootstrapChunk(9))

    // The grant is the server's answer: no world follows THIS admission. A chunk
    // arriving afterwards is unexplained, and the sink treats it as it treated
    // every unexplained world before POD-2061 — offered, freshness-checked, never
    // presumed to be the one a walk is owed.
    expect(armed).toBe(0)
  })

  it('feeds the resume grant to nothing — the replica heals from its own cursor', () => {
    const received: unknown[] = []
    const seen: [string, number | null][] = []
    const sink = new FeedSink({
      replica: {
        connect: () => {},
        disconnect: () => {},
        receive: (frame: unknown) => received.push(frame),
        cursor: { feedId: 'feed_1', epoch: 'epoch_1', seq: 4 },
      } as never,
      bootstraps: { expectWorld: () => {}, isWalking: () => false } as never,
      onFrame: (kind, seq) => seen.push([kind, seq]),
    })

    sink.connected(false)
    sink.frame({ type: 'feedResume', feedId: 'feed_1', epoch: 'epoch_1', seq: 4 })

    expect(received).toEqual([])
    expect(seen).toEqual([['feedResume', 4]])
  })

  it('reports the position it holds, and nothing when it holds none', () => {
    const withCursor = new FeedSink({
      replica: { cursor: { feedId: 'feed_1', epoch: 'epoch_1', seq: 12 } } as never,
      bootstraps: {} as never,
    })
    expect(withCursor.helloFields()).toEqual({
      feedCursor: { feedId: 'feed_1', epoch: 'epoch_1', seq: 12 },
    })

    const cold = new FeedSink({ replica: { cursor: null } as never, bootstraps: {} as never })
    expect(cold.helloFields()).toBeNull()
  })

  it('keeps an in-flight bootstrap walk alive across its requested socket replacement', () => {
    let requested = true
    let disconnects = 0
    const sink = new FeedSink({
      replica: {
        connect: () => {},
        disconnect: () => {
          disconnects += 1
        },
        receive: () => {},
      } as never,
      bootstraps: {
        reset: () => {
          const result = requested
          requested = false
          return result
        },
      } as never,
    })

    sink.disconnected()
    expect(disconnects).toBe(0)

    sink.disconnected()
    expect(disconnects).toBe(1)
  })
})
