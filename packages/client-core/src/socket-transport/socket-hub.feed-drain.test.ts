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


const rawBootstrap = (
  last: boolean,
  changes: ReadonlyArray<Record<string, unknown>> = [],
): string =>
  JSON.stringify({
    type: 'feedDelta',
    feedId: 'feed-1',
    epoch: 'e1',
    fromSeq: 0,
    seq: changes.length === 0 ? 0 : 2,
    minAvailableSeq: 0,
    changes,
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
      { type: 'feedDelta', changes: [{ entityId: 'first' }] },
      { type: 'feedDelta', changes: [{ entityId: 'last' }] },
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
      expect.objectContaining({ type: 'feedDelta', changes: [] }),
    ])
    expect(hub.feedBudget()).toMatchObject({ tasks: 1, yieldedTasks: 1 })
    hub.dispose()
  })

  it('requests HTTP recovery for a runaway backlog without closing or losing the resume cursor', () => {
    const sock = new FakeSocket()
    const recovery = vi.fn()
    const hub = new SocketHub({
      url: 'ws://x', makeSocket: () => sock, scheduleFeedTask: () => {},
      feed: { syncHttp: true, requestRebootstrap: recovery,
        helloFields: () => ({ feedCursor: { feedId: 'feed-1', epoch: 'e1', seq: 7 } }),
        connected() {}, disconnected() {}, frame() {} },
    })
    hub.connect()
    sock.open()
    for (let seq = 1; seq <= FEED_DELTA_RESYNC_QUEUE_DEPTH + 1; seq++) sock.deliver(rawDelta(seq))
    expect(recovery).toHaveBeenCalledOnce()
    expect(sock.closed).toBe(false)
    expect(hub.connected).toBe(true)
    expect(sock.parsed().find(frame => frame.type === 'hello')).toMatchObject({
      feedCursor: { feedId: 'feed-1', epoch: 'e1', seq: 7 },
    })
    expect(hub.feedBudget().backlogResyncs).toBe(1)
    hub.dispose()
  })
})
