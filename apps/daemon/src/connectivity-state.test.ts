// The daemon reports its enrolled link truthfully. Fresh enrollment belongs
// to the machine supervisor; reconnect and credential rejection stay here.
import { mkdtempSync, rmSync, watch } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_WIRE_VERSION, type PeerHelloReply } from '@podium/protocol'
import { connectivityPath, readConnectivityForTest } from '@podium/runtime/connectivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { type ReconnectTimers, startDaemon } from './daemon'
import { loadIdentity, saveToken } from './identity'

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('daemon connectivity state (#19)', () => {
  let dir: string
  let httpServer: Server
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-conn-'))
    process.env.PODIUM_STATE_DIR = dir
    // Mount the ws server on an explicit http server so teardown can force lingering
    // sockets shut (server.closeAllConnections) — a WebSocketServer that owns its own
    // port hides that server, and under Bun its close() callback waits forever for a
    // re-dial from the daemon's backoff loop to disconnect on its own.
    httpServer = createServer()
    wss = new WebSocketServer({ server: httpServer })
    await new Promise<void>((r) => httpServer.listen(0, () => r()))
    port = (httpServer.address() as { port: number }).port
  })
  afterEach(async () => {
    process.env.PODIUM_STATE_DIR = priorStateDir
    for (const c of wss.clients) c.terminate()
    await new Promise<void>((r) => wss.close(() => r()))
    httpServer.closeAllConnections?.()
    await new Promise<void>((r) => httpServer.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  const bootOpts = (extra: object) => ({
    serverUrl: `ws://localhost:${port}`,
    identityDir: dir,
    backend: 'none' as const,
    hooks: { port: 0, settingsDir: join(dir, 'hooks') },
    agentRelay: { port: 0 },
    discovery: { background: false as const, cachePath: ':memory:' },
    metrics: { background: false as const },
    ...extra,
  })

  function controlledReconnectClock() {
    const active = new Set<{ fire: () => void; ms: number }>()
    const timers: ReconnectTimers = {
      setTimeout: (fire, ms) => {
        const timer = { fire, ms }
        active.add(timer)
        return timer
      },
      clearTimeout: (timer) => {
        active.delete(timer as { fire: () => void; ms: number })
      },
    }
    return {
      timers,
      next: async () => {
        // The successful HELLO cancels its acknowledgement deadline. Observe
        // the surviving reconnect timer, not the first timer the transport arms.
        await vi.waitFor(() => expect(active.size).toBe(1))
        return [...active][0]!
      },
    }
  }

  it('reconnects with its enrolled token without restarting the daemon', async () => {
    saveToken('tok-reconnect', { dir })
    const handshakes: Array<Record<string, unknown>> = []
    const reconnectClock = controlledReconnectClock()
    let resolveReconnected!: (frame: Record<string, unknown>) => void
    const reconnected = new Promise<Record<string, unknown>>((resolve) => {
      resolveReconnected = resolve
    })
    wss.on('connection', (ws) => {
      ws.once('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>
        handshakes.push(frame)
        if (handshakes.length === 1) {
          const reply: PeerHelloReply = {
            type: 'peerHelloOk',
            v: DAEMON_WIRE_VERSION,
            caps: [],
            name: 'box',
          }
          ws.send(JSON.stringify(reply), () => ws.close())
          return
        }
        const reply: PeerHelloReply = {
          type: 'peerHelloOk',
          v: DAEMON_WIRE_VERSION,
          caps: [],
          name: 'box',
        }
        ws.send(JSON.stringify(reply))
        resolveReconnected(frame)
      })
    })

    const daemon = await startDaemon(bootOpts({ reconnectTimers: reconnectClock.timers }))
    try {
      const retry = await reconnectClock.next()
      expect(retry.ms).toBe(500)
      const connectedAgain = new Promise<void>((resolve) => {
        const watcher = watch(connectivityPath(dir), () => {
          if (readConnectivityForTest(dir)?.state !== 'connected') return
          watcher.close()
          resolve()
        })
      })
      retry.fire()
      await Promise.all([reconnected, connectedAgain])
      expect(handshakes).toHaveLength(2)
      expect(handshakes[0]).toMatchObject({
        type: 'peerHello',
        credential: {
          kind: 'machineToken',
          token: 'tok-reconnect',
          machineHint: loadIdentity({ dir }).machineId,
        },
      })
      expect(handshakes[1]).toMatchObject({
        type: 'peerHello',
        credential: { kind: 'machineToken', token: 'tok-reconnect' },
      })
      expect(readConnectivityForTest(dir)?.state).toBe('connected')
    } finally {
      await daemon.close()
    }
  })

  it('a terminal credential rejection records unauthorized and fires onBlocked without reconnecting', async () => {
    saveToken('invalid-enrolled-token', { dir })
    let connections = 0
    wss.on('connection', (ws) => {
      connections++
      ws.once('message', () => {
        const reply: PeerHelloReply = {
          type: 'peerHelloRejected',
          reason: 'auth-failed',
          message: 'invalid or expired code',
        }
        ws.send(JSON.stringify(reply))
      })
    })
    const onBlocked = vi.fn()
    await expect(startDaemon(bootOpts({ onBlocked }))).rejects.toThrow(/rejected/)
    const conn = readConnectivityForTest(dir)
    expect(conn?.state).toBe('unauthorized')
    expect(conn?.authorizationReason).toContain('peerHelloRejected')
    expect(conn?.authorizationReason).toContain('invalid or expired code')
    expect(onBlocked).toHaveBeenCalledWith({
      type: 'peerHelloRejected',
      reason: 'invalid or expired code',
    })
    // Blocked is terminal: give the backoff window a chance and assert no re-dial happened.
    await new Promise((r) => setTimeout(r, 700))
    expect(connections).toBe(1)
  })

  it('losing the server records disconnected (with backoff) but keeps the last-contact time', async () => {
    let first = true
    wss.on('connection', (ws) => {
      if (!first) {
        ws.close() // later re-dials are refused pre-handshake → stays disconnected
        return
      }
      first = false
      ws.once('message', () => {
        const reply: PeerHelloReply = {
          type: 'peerHelloOk',
          v: DAEMON_WIRE_VERSION,
          caps: [],
          name: 'box',
        }
        ws.send(JSON.stringify(reply))
        // Server goes away right after a healthy handshake.
        setTimeout(() => ws.close(), 10)
      })
    })
    // A stored token (not machineToken — that disables the status file) → hello path.
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ machineId: 'm-1', token: 't-1' }))
    const daemon = await startDaemon(bootOpts({}))
    try {
      await vi.waitFor(() => {
        const conn = readConnectivityForTest(dir)
        expect(conn?.state).toBe('disconnected')
      })
      const conn = readConnectivityForTest(dir)
      expect(conn?.lastHelloOkAt).toBeTruthy() // "last seen" survives the disconnect
      expect(conn?.retryBackoffMs).toBeGreaterThan(0)
    } finally {
      await daemon.close()
    }
  })
})
