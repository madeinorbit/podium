import { asSessionId } from '@podium/model'
import { encode } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SocketHub, type WebSocketLike } from './socket-hub'

/**
 * The transport half of native connectivity (POD-2055 F4 / WP-C3+C5).
 *
 * A phone that is backgrounded keeps none of this running: iOS suspends the
 * process's timers unreliably and kills its sockets eventually, so a hub that
 * pings every 2.5 s and re-dials forever is spending battery on a connection the
 * OS is about to take anyway — and, worse, is still telling the server this
 * client is watching, which suppresses the push notification the person
 * backgrounded the app to receive.
 */

/** Records every outbound frame AND the close, in one ordered log: the point of
 *  the suspend path is what happens BEFORE the socket goes away. */
class LoggingSocket implements WebSocketLike {
  readonly log: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  send(data: string): void {
    const type = String((JSON.parse(data) as { type?: unknown }).type)
    this.log.push(type)
    // ANSWER THE PINGS. An unanswered ping force-closes the socket after
    // HEARTBEAT_TIMEOUT_MS, so a mute fake server measures the watchdog rather
    // than the cadence — and at a 10 s cadence the two land on the same tick.
    //
    // On a TIMER, not inline: the hub arms its deadline AFTER `send` returns, so
    // a synchronous answer would be cleared before there was anything to clear.
    if (type === 'ping') setTimeout(() => this.onmessage?.({ data: encode({ type: 'pong' }) }), 0)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.log.push('<close>')
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  pings(): number {
    return this.log.filter((entry) => entry === 'ping').length
  }
}

const hubs: SocketHub[] = []

function makeHub(options: { heartbeatIntervalMs?: number } = {}): {
  sockets: LoggingSocket[]
  hub: SocketHub
} {
  const sockets: LoggingSocket[] = []
  const hub = new SocketHub({
    url: 'ws://transport.test',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    makeSocket: () => {
      const socket = new LoggingSocket()
      sockets.push(socket)
      return socket
    },
    ...options,
  })
  hubs.push(hub)
  return { sockets, hub }
}

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.dispose()
  vi.useRealTimers()
})

describe('heartbeat interval as an option', () => {
  it('pings on the web cadence by default', () => {
    vi.useFakeTimers()
    const { sockets, hub } = makeHub()
    hub.connect()
    sockets[0]?.open()
    expect(sockets[0]?.pings()).toBe(1)
    vi.advanceTimersByTime(2_500)
    expect(sockets[0]?.pings()).toBe(2)
  })

  it('pings on the interval the embedder asked for', () => {
    vi.useFakeTimers()
    const { sockets, hub } = makeHub({ heartbeatIntervalMs: 10_000 })
    hub.connect()
    sockets[0]?.open()
    // Still one immediate ping on connect: it is what confirms the server is
    // answering, and a slower cadence must not delay that.
    expect(sockets[0]?.pings()).toBe(1)
    vi.advanceTimersByTime(9_999)
    expect(sockets[0]?.pings()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(sockets[0]?.pings()).toBe(2)
  })
})

describe('suspend', () => {
  it('reports invisibility to the server BEFORE the socket goes away', () => {
    const { sockets, hub } = makeHub()
    hub.connect()
    sockets[0]?.open()
    hub.subscribeRoom({ kind: 'session', id: asSessionId('s-room') })
    hub.setVisible(false)
    hub.suspend()
    const log = sockets[0]?.log ?? []
    expect(log).toContain('presenceUpdate')
    expect(log.indexOf('presenceUpdate')).toBeLessThan(log.indexOf('<close>'))
    expect(sockets[0]?.closed).toBe(true)
  })

  it('stops the heartbeat and leaves no reconnect behind', () => {
    vi.useFakeTimers()
    const { sockets, hub } = makeHub()
    hub.connect()
    sockets[0]?.open()
    const pingsAtSuspend = sockets[0]?.pings() ?? 0
    hub.suspend()
    vi.advanceTimersByTime(60_000)
    expect(sockets[0]?.pings()).toBe(pingsAtSuspend)
    // The whole point: a backgrounded app must not sit in a reconnect loop.
    expect(sockets).toHaveLength(1)
    expect(hub.connected).toBe(false)
  })

  it('is idempotent and harmless with no socket open', () => {
    const { sockets, hub } = makeHub()
    hub.suspend()
    hub.suspend()
    expect(sockets).toHaveLength(0)
  })

  it('does not survive as a latch: connectNow reconnects a suspended hub at once', () => {
    vi.useFakeTimers()
    const { sockets, hub } = makeHub()
    hub.connect()
    sockets[0]?.open()
    hub.suspend()
    hub.connectNow()
    expect(sockets).toHaveLength(2)
    sockets[1]?.open()
    expect(hub.connected).toBe(true)
  })

  it('refuses to reconnect a DISPOSED hub, which is the other intentional close', () => {
    // The distinction suspend introduced: both stop the socket on purpose, and
    // only one of them is meant to come back. A build that collapses them either
    // wedges a backgrounded phone offline forever or resurrects a torn-down
    // runtime's transport.
    vi.useFakeTimers()
    const { sockets, hub } = makeHub()
    hub.connect()
    sockets[0]?.open()
    hub.dispose()
    hub.connectNow()
    expect(sockets).toHaveLength(1)
  })

  it('resumes the heartbeat after a foreground reconnect', () => {
    vi.useFakeTimers()
    const { sockets, hub } = makeHub({ heartbeatIntervalMs: 10_000 })
    hub.connect()
    sockets[0]?.open()
    hub.suspend()
    hub.connectNow()
    sockets[1]?.open()
    expect(sockets[1]?.pings()).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(sockets[1]?.pings()).toBe(2)
  })

  it('stays suspended when the socket close arrives after the fact', () => {
    vi.useFakeTimers()
    const { sockets, hub } = makeHub()
    hub.connect()
    sockets[0]?.open()
    hub.suspend()
    // A real WebSocket delivers onclose asynchronously; a hub that treated that
    // as an unexpected drop would start reconnecting from the background anyway.
    sockets[0]?.onclose?.({})
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
  })
})
