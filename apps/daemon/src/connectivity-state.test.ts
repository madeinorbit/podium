// Issue #19: the daemon must TELL THE TRUTH about its server link — a status file next to
// daemon.json records connected / disconnected / terminally-blocked, a consumed pair code is
// dropped from config.json, and a terminal rejection fires onBlocked (the CLI's distinct-exit
// hook) instead of crash-looping.
import { mkdtempSync, rmSync, watch } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PeerHelloReply, WIRE_VERSION } from '@podium/protocol'
import { loadConfig, saveConfig } from '@podium/runtime/config'
import { connectivityPath, readConnectivity } from '@podium/runtime/connectivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { type ReconnectTimers, startDaemon } from './daemon'
import { loadIdentity } from './identity'

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
    tmux: false as const,
    hooks: { port: 0, settingsDir: join(dir, 'hooks') },
    agentRelay: { port: 0 },
    discovery: { background: false as const, cachePath: ':memory:' },
    metrics: { background: false as const },
    ...extra,
  })

  function controlledReconnectClock(): {
    timers: ReconnectTimers
    next: Promise<{ fire: () => void; ms: number }>
  } {
    let resolveNext!: (timer: { fire: () => void; ms: number }) => void
    const next = new Promise<{ fire: () => void; ms: number }>((resolve) => {
      resolveNext = resolve
    })
    const timers: ReconnectTimers = {
      setTimeout: (fire, ms) => {
        const timer = { fire, ms }
        resolveNext(timer)
        return timer
      },
      clearTimeout: vi.fn(),
    }
    return { timers, next }
  }

  it('a successful pair writes connected state, persists the token, and consumes the pair code', async () => {
    // The join wrote mode/serverUrl/pairCode; the pair must clear ONLY the consumed code.
    saveConfig({
      mode: 'daemon',
      serverUrl: `ws://localhost:${port}`,
      pairCode: 'CODE-1',
      updateChannel: 'edge',
    })
    wss.on('connection', (ws) => {
      ws.once('message', () => {
        const reply: PeerHelloReply = {
          type: 'peerHelloOk',
          v: WIRE_VERSION,
          caps: [],
          issuedToken: 'tok-1',
          assignedId: 'm-1',
          name: 'box',
        }
        ws.send(JSON.stringify(reply))
      })
    })
    const daemon = await startDaemon(bootOpts({ pairCode: 'CODE-1' }))
    try {
      const conn = readConnectivity(dir)
      expect(conn?.state).toBe('connected')
      expect(conn?.lastHelloOkAt).toBeTruthy()
      expect(conn?.serverUrl).toBe(`ws://localhost:${port}`)
      // Token persisted; identity survived.
      expect(loadIdentity({ dir }).token).toBe('tok-1')
      // Consumed pair code dropped; the REST of the config is untouched.
      const cfg = loadConfig()
      expect(cfg.pairCode).toBeUndefined()
      expect(cfg.updateChannel).toBe('edge')
      expect(cfg.serverUrl).toBe(`ws://localhost:${port}`)
    } finally {
      await daemon.close()
    }
  })

  it('reconnects with the freshly paired token without restarting the daemon', async () => {
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
            v: WIRE_VERSION,
            caps: [],
            issuedToken: 'tok-reconnect',
            assignedId: 'm-1',
            name: 'box',
          }
          ws.send(JSON.stringify(reply), () => ws.close())
          return
        }
        const reply: PeerHelloReply = {
          type: 'peerHelloOk',
          v: WIRE_VERSION,
          caps: [],
          name: 'box',
        }
        ws.send(JSON.stringify(reply))
        resolveReconnected(frame)
      })
    })

    const daemon = await startDaemon(
      bootOpts({ pairCode: 'CODE-1', reconnectTimers: reconnectClock.timers }),
    )
    try {
      const retry = await reconnectClock.next
      expect(retry.ms).toBe(500)
      const connectedAgain = new Promise<void>((resolve) => {
        const watcher = watch(connectivityPath(dir), () => {
          if (readConnectivity(dir)?.state !== 'connected') return
          watcher.close()
          resolve()
        })
      })
      retry.fire()
      await Promise.all([reconnected, connectedAgain])
      expect(handshakes).toHaveLength(2)
      expect(handshakes[0]).toMatchObject({
        type: 'peerHello',
        credential: { kind: 'pairCode', code: 'CODE-1' },
      })
      expect(handshakes[1]).toMatchObject({
        type: 'peerHello',
        credential: { kind: 'machineToken', token: 'tok-reconnect' },
      })
      expect(readConnectivity(dir)?.state).toBe('connected')
    } finally {
      await daemon.close()
    }
  })

  it('a terminal pairRejected writes the blocked marker and fires onBlocked (no reconnect loop)', async () => {
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
    await expect(startDaemon(bootOpts({ pairCode: 'WRONG', onBlocked }))).rejects.toThrow(
      /rejected/,
    )
    const conn = readConnectivity(dir)
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
          v: WIRE_VERSION,
          caps: [],
          name: 'box',
        }
        ws.send(JSON.stringify(reply))
        // Server goes away right after a healthy handshake.
        setTimeout(() => ws.close(), 10)
      })
    })
    // A stored token (not bootstrapToken — that disables the status file) → hello path.
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ machineId: 'm-1', token: 't-1' }))
    const daemon = await startDaemon(bootOpts({}))
    try {
      await vi.waitFor(() => {
        const conn = readConnectivity(dir)
        expect(conn?.state).toBe('disconnected')
      })
      const conn = readConnectivity(dir)
      expect(conn?.lastHelloOkAt).toBeTruthy() // "last seen" survives the disconnect
      expect(conn?.retryBackoffMs).toBeGreaterThan(0)
    } finally {
      await daemon.close()
    }
  })
})
