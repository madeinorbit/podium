import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { type BootProc, bootProcess } from '@podium/runtime/boot'
import { closeServerFast } from './shutdown'

/** Minimal server double: close() resolves immediately, records force-close. */
function makeServerDouble() {
  const closeAllConnections = vi.fn()
  const close = vi.fn((cb?: (err?: Error) => void) => {
    cb?.()
    return undefined as never
  })
  return { close, closeAllConnections }
}

describe('closeServerFast', () => {
  it('runs every persistence step in order, then force-closes the network', async () => {
    const order: string[] = []
    const srv = makeServerDouble()
    await closeServerFast({
      closeWebSockets: () => {
        order.push('ws')
        return Promise.resolve()
      },
      server: {
        close: (cb?: (err?: Error) => void) => {
          order.push('http.close')
          cb?.()
          return undefined as never
        },
        closeAllConnections: () => order.push('http.closeAllConnections'),
      } as never,
      persist: [
        ['a', () => order.push('a')],
        ['b', () => order.push('b')],
      ],
    })
    expect(order).toEqual(['ws', 'a', 'b', 'http.close', 'http.closeAllConnections'])
    void srv
  })

  it('persistence still runs when the WS close never resolves (bounded by the grace)', async () => {
    const persisted = vi.fn()
    const srv = makeServerDouble()
    await closeServerFast({
      closeWebSockets: () => new Promise<void>(() => {}), // hangs forever
      server: srv as never,
      persist: [['store.close', persisted]],
      wsCloseGraceMs: 10,
    })
    expect(persisted).toHaveBeenCalledTimes(1)
    expect(srv.closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('one throwing persistence step logs and does not skip the rest', async () => {
    const errors: string[] = []
    const ran: string[] = []
    await closeServerFast({
      closeWebSockets: () => Promise.resolve(),
      server: makeServerDouble() as never,
      persist: [
        ['flushActivity', () => ran.push('flushActivity')],
        [
          'registry.dispose',
          () => {
            throw new Error('dispose boom')
          },
        ],
        ['store.close', () => ran.push('store.close')],
      ],
      logError: (msg) => errors.push(msg),
    })
    expect(ran).toEqual(['flushActivity', 'store.close'])
    expect(errors).toEqual([
      expect.stringContaining("shutdown step 'registry.dispose' failed: Error: dispose boom"),
    ])
  })

  it('a rejecting or synchronously-throwing WS close is logged, never fatal', async () => {
    const errors: string[] = []
    const persisted = vi.fn()
    await closeServerFast({
      closeWebSockets: () => Promise.reject(new Error('ws gone')),
      server: makeServerDouble() as never,
      persist: [['p', persisted]],
      logError: (msg) => errors.push(msg),
    })
    await closeServerFast({
      closeWebSockets: () => {
        throw new Error('sync ws boom')
      },
      server: makeServerDouble() as never,
      persist: [['p', persisted]],
      logError: (msg) => errors.push(msg),
    })
    expect(persisted).toHaveBeenCalledTimes(2)
    expect(errors).toEqual([
      expect.stringContaining('websocket close failed'),
      expect.stringContaining('websocket close threw'),
    ])
  })

  it('a missing closeAllConnections is tolerated (older runtime): close callback still settles it', async () => {
    const close = vi.fn((cb?: (err?: Error) => void) => {
      cb?.()
      return undefined as never
    })
    await closeServerFast({
      closeWebSockets: () => Promise.resolve(),
      server: { close } as never,
      persist: [],
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('force-close makes a REAL node:http close resolve despite a lingering keep-alive socket', async () => {
    const server = createServer((_req, res) => res.end('ok'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    // Open a keep-alive connection and complete one request so the socket lingers.
    const sock = connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => {
      sock.on('connect', () =>
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n'),
      )
      sock.on('data', () => resolve())
    })
    const persisted = vi.fn()
    // Without closeAllConnections this would hang until the socket drains
    // (i.e. essentially forever) — the POD-611 4s-per-restart floor.
    await expect(
      closeServerFast({
        closeWebSockets: () => Promise.resolve(),
        server,
        persist: [['store.close', persisted]],
      }),
    ).resolves.toBeUndefined()
    expect(persisted).toHaveBeenCalledTimes(1)
    sock.destroy()
  })

  it('http close that never fires its callback still resolves within httpCloseGraceMs', async () => {
    // Bun can leave upgraded WebSocket sockets counted forever; the callback never
    // runs even after closeAllConnections. Awaiters (e2e afterAll, hub restart)
    // must not hang — persistence already ran above.
    const persisted = vi.fn()
    const t0 = Date.now()
    await closeServerFast({
      closeWebSockets: () => Promise.resolve(),
      server: { close: vi.fn() } as never, // callback never fires
      persist: [['store.close', persisted]],
      httpCloseGraceMs: 30,
    })
    expect(persisted).toHaveBeenCalledTimes(1)
    expect(Date.now() - t0).toBeLessThan(200)
  })

  it('under bootProcess: persistence runs and exit(0) lands within the backstop even if http close hangs', async () => {
    // End-to-end with the boot kernel, server-style: a close whose network
    // stage never settles (no closeAllConnections, no close callback) must
    // still have persisted BEFORE the kernel's closeTimeoutMs race exits —
    // the exact failure POD-611 fixes (persistence used to live inside the
    // never-firing close callback).
    const persisted = vi.fn()
    const handlers = new Map<string, () => void>()
    const proc: BootProc = {
      exit: vi.fn(),
      onSignal: (signal, handler) => {
        handlers.set(signal, handler)
      },
      installSafetyNet: vi.fn(),
      startWatchdog: vi.fn(() => () => {}),
      log: vi.fn(),
      error: vi.fn(),
      stayAlive: () => Promise.resolve(),
    }
    await bootProcess(
      {
        name: 'server',
        bootTimeoutMs: null,
        closeTimeoutMs: 50,
        start: async () => ({
          close: () =>
            closeServerFast({
              closeWebSockets: () => Promise.resolve(),
              server: { close: vi.fn() } as never, // callback never fires, no force-close
              persist: [['store.close', persisted]],
            }),
        }),
      },
      proc,
    )
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0))
    expect(persisted).toHaveBeenCalledTimes(1)
  })
})
