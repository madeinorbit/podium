import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { encode, type ServerMessage } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SocketHub, type WebSocketLike } from './socket-hub'

/**
 * THE CONNECTION'S OWN NARRATIVE (POD-1935).
 *
 * A live session that lost its socket across a server restart produced a run of
 * console errors and not one log record, so the crash report that followed
 * carried a flight recorder with nothing in it. A drop and its retry are the
 * context that explains most of what a client does next, so they are written
 * down: `warn` for the drop, which forwards at the client's default threshold,
 * and `debug` for the reconnect attempts, which are ring-buffer context.
 */

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
  error(): void {
    this.onerror?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  recv(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
}

let logged: LogRecord[]

function setup(makeSocket?: () => WebSocketLike) {
  const sock = new FakeSocket()
  const hub = new SocketHub({
    url: 'ws://x',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    makeSocket: makeSocket ?? (() => sock),
  })
  return { sock, hub }
}

const of = (ns: string): LogRecord[] => logged.filter((record) => record.ns === ns)

beforeEach(() => {
  vi.useFakeTimers()
  resetLogging()
  logged = []
  addSink({ name: 'capture', write: (record) => logged.push(record) })
  setLogLevel('trace')
})

afterEach(() => {
  vi.useRealTimers()
  resetLogging()
})

describe('SocketHub logging', () => {
  it('records the connection opening', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    expect(of('client-core:socket-hub').map((r) => [r.level, r.msg])).toContainEqual([
      'info',
      'socket connected',
    ])
    hub.dispose()
  })

  it('records an unexpected drop at warn, with the retry delay', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    logged.length = 0
    sock.close()

    const drop = of('client-core:socket-hub').find((r) => r.level === 'warn')
    expect(drop?.msg).toBe('socket closed — reconnecting')
    expect(typeof drop?.retryInMs).toBe('number')
    hub.dispose()
  })

  it('says nothing about a socket the caller closed on purpose', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    logged.length = 0
    hub.dispose()
    expect(of('client-core:socket-hub').filter((r) => r.level === 'warn')).toEqual([])
  })

  it('records a socket that could not be constructed at all', () => {
    const { hub } = setup(() => {
      throw new Error('bad url')
    })
    hub.connect()
    const failure = of('client-core:socket-hub').find((r) => r.level === 'warn')
    expect(failure?.msg).toBe('socket could not be opened')
    expect(failure?.err).toMatchObject({ message: 'bad url' })
    hub.dispose()
  })
})
