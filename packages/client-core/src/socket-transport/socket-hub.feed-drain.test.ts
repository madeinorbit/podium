import { afterEach, describe, expect, it, vi } from 'vitest'
import { FEED_DELTA_RESYNC_QUEUE_DEPTH, SocketHub, type WebSocketLike } from './socket-hub'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  deliver(raw: string): void {
    this.onmessage?.({ data: raw })
  }
  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>)
  }
}

const viewport = { cols: 80, rows: 24, dpr: 1 }

const rawBootstrap = (
  last: boolean,
  changes: ReadonlyArray<Record<string, unknown>> = [],
): string =>
  JSON.stringify({
    type: 'feedBootstrap',
    feedId: 'feed-1',
    epoch: 'e1',
    fromSeq: 0,
    seq: changes.length === 0 ? 0 : 2,
    minAvailableSeq: 0,
    changes,
    last,
  })

const rawDelta = (seq: number): string =>
  JSON.stringify({
    type: 'feedDelta',
    feedId: 'feed-1',
    epoch: 'e1',
    fromSeq: seq - 1,
    seq,
    minAvailableSeq: 0,
    changes: [],
  })

const bootstrapRow = (entityId: string): Record<string, unknown> => ({
  seq: entityId === 'first' ? 1 : 2,
  entity: 'userReadPosition',
  entityId,
  op: 'upsert',
  value: { userId: 'user:sole' },
})

/**
 * A real macrotask turn taken through the test's own channel, so it still turns
 * with every timer frozen — which is the whole condition under test.
 */
function macrotaskTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(0)
  })
}

async function macrotaskTurns(count: number): Promise<void> {
  for (let i = 0; i < count + 1; i += 1) await macrotaskTurn()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SocketHub feed ingress drain', () => {
  it('drains feed frames with every timer frozen, as a hidden tab clamps them', async () => {
    vi.useFakeTimers()
    const sock = new FakeSocket()
    const frames: unknown[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport,
      makeSocket: () => sock,
      feed: {
        helloFields: () => null,
        connected: () => {},
        disconnected: () => {},
        frame: (frame) => frames.push(frame),
      },
    })
    hub.connect()
    sock.open()

    sock.deliver(rawBootstrap(false, [bootstrapRow('first')]))
    sock.deliver(rawBootstrap(true, [bootstrapRow('last')]))
    expect(frames).toHaveLength(0)

    await macrotaskTurns(2)

    expect(frames).toMatchObject([
      { type: 'feedBootstrap', changes: [{ entityId: 'first' }], last: false },
      { type: 'feedBootstrap', changes: [{ entityId: 'last' }], last: true },
    ])
    expect(hub.feedBudget()).toMatchObject({ tasks: 2, yieldedTasks: 2 })
    hub.dispose()
  })

  it('re-arms its owned feed scheduler after a StrictMode dispose and remount', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const frames: unknown[] = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport,
      makeSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      feed: {
        helloFields: () => null,
        connected: () => {},
        disconnected: () => {},
        frame: (frame) => frames.push(frame),
      },
    })

    hub.connect()
    sockets[0]?.open()
    sockets[0]?.deliver(rawBootstrap(true))
    hub.dispose()
    expect(frames).toEqual([])

    hub.connect()
    sockets[1]?.open()
    sockets[1]?.deliver(JSON.stringify({ type: 'welcome', clientId: 'replacement' }))
    sockets[1]?.deliver(rawBootstrap(true))
    await macrotaskTurns(2)

    expect(hub.clientId).toBe('replacement')
    expect(frames).toEqual([
      expect.objectContaining({ type: 'feedBootstrap', changes: [], last: true }),
    ])
    expect(hub.feedBudget()).toMatchObject({ tasks: 1, yieldedTasks: 1 })
    hub.dispose()
  })

  /**
   * WHERE THE QUEUE CEILING IS TESTED, AND WHY MOST OF IT IS NOT HERE.
   *
   * POD-2058 shipped this file with its own ceiling — `FEED_INGRESS_QUEUE_LIMIT`,
   * 2000 frames of ANY kind, counter `queueOverflows` — and the same recovery was
   * built independently on main as `FEED_DELTA_RESYNC_QUEUE_DEPTH`: 256 frames,
   * counting DELTAS only. Only one bound may own this queue, and main's is the
   * one that survived the rebase, because counting every frame kind is a defect
   * rather than a preference: a large world legitimately arrives as an
   * arbitrarily long run of `feedBootstrap` chunks, so a whole-queue bound
   * abandons the download and asks for another world, forever.
   *
   * `socket-hub.test.ts` therefore owns the bound's two cases (deltas trip it,
   * bootstrap chunks do not). What stays here is the assertion that pair does not
   * make: after the cycle, the reconnect presents NO position, so the server owes
   * it a whole world — the thing that makes "nothing was dropped" true.
   */
  it('reconnects with no position after a runaway backlog, so the server owes it a world', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const helloFieldsCalls: number[] = []
    const disconnects: number[] = []
    const starved: Array<() => void> = []
    const hub = new SocketHub({
      url: 'ws://x',
      viewport,
      makeSocket: () => {
        const sock = new FakeSocket()
        sockets.push(sock)
        return sock
      },
      feed: {
        helloFields: () => {
          helloFieldsCalls.push(1)
          return { feedId: 'feed-1', epoch: 'e1', seq: 7 } as never
        },
        connected: () => {},
        disconnected: () => disconnects.push(1),
        frame: () => {},
      },
      // The drain never runs: the wedged main thread this guard exists for.
      scheduleFeedTask: (task) => starved.push(task),
    })
    hub.connect()
    sockets[0]?.open()
    expect(helloFieldsCalls).toHaveLength(1)

    for (let seq = 1; seq <= FEED_DELTA_RESYNC_QUEUE_DEPTH + 1; seq += 1) {
      sockets[0]?.deliver(rawDelta(seq))
    }

    // The socket was cycled rather than the queue left to grow.
    expect(hub.feedBudget().backlogResyncs).toBe(1)
    expect(sockets[0]?.closed).toBe(true)
    expect(disconnects).toHaveLength(1)
    expect(hub.connected).toBe(false)

    // …and the reconnect presents no position, so the server owes it a world.
    // Nothing was dropped: the world supersedes every frame the queue held.
    vi.advanceTimersByTime(30_000)
    sockets[1]?.open()
    expect(sockets).toHaveLength(2)
    expect(helloFieldsCalls).toHaveLength(1)
    const hello = sockets[1]?.parsed().find((frame) => frame.type === 'hello')
    expect(hello).toBeDefined()
    expect(hello).not.toHaveProperty('feedId')

    // The new connection queues from empty — the backlog went with the old
    // socket rather than carrying over and tripping the bound again at once.
    sockets[1]?.deliver(rawDelta(1))
    sockets[1]?.deliver(rawDelta(2))
    expect(hub.feedBudget().backlogResyncs).toBe(1)

    hub.dispose()
  })
})
