// Issue #19: the daemon must TELL THE TRUTH about its server link — a status file next to
// daemon.json records connected / disconnected / terminally-blocked, a consumed pair code is
// dropped from config.json, and a terminal rejection fires onBlocked (the CLI's distinct-exit
// hook) instead of crash-looping.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig } from '@podium/core/config'
import { readConnectivity } from '@podium/core/connectivity'
import type { DaemonHandshakeReply } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { loadIdentity } from './identity'

import { startDaemon } from './daemon'

describe('daemon connectivity state (#19)', () => {
  let dir: string
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-conn-'))
    process.env.PODIUM_STATE_DIR = dir
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    port = (wss.address() as { port: number }).port
  })
  afterEach(async () => {
    delete process.env.PODIUM_STATE_DIR
    await new Promise<void>((r) => wss.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  const bootOpts = (extra: object) => ({
    serverUrl: `ws://localhost:${port}`,
    identityDir: dir,
    tmux: false as const,
    hooks: { port: 0, settingsDir: join(dir, 'hooks') },
    issueRelay: { port: 0 },
    discovery: { background: false as const, cachePath: ':memory:' },
    metrics: { background: false as const },
    ...extra,
  })

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
        const reply: DaemonHandshakeReply = {
          type: 'paired',
          token: 'tok-1',
          machineId: 'm-1',
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

  it('a terminal pairRejected writes the blocked marker and fires onBlocked (no reconnect loop)', async () => {
    let connections = 0
    wss.on('connection', (ws) => {
      connections++
      ws.once('message', () => {
        const reply: DaemonHandshakeReply = { type: 'pairRejected', reason: 'bad code' }
        ws.send(JSON.stringify(reply))
      })
    })
    const onBlocked = vi.fn()
    await expect(startDaemon(bootOpts({ pairCode: 'WRONG', onBlocked }))).rejects.toThrow(
      /rejected/,
    )
    const conn = readConnectivity(dir)
    expect(conn?.state).toBe('blocked')
    expect(conn?.blockedReason).toContain('pairRejected')
    expect(conn?.blockedReason).toContain('bad code')
    expect(onBlocked).toHaveBeenCalledWith({ type: 'pairRejected', reason: 'bad code' })
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
        const reply: DaemonHandshakeReply = { type: 'helloOk', name: 'box' }
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
