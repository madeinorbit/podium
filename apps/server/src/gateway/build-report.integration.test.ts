import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandshakeDialer, type PeerBuild } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startServer } from '../server'

const priorStateDir = process.env.PODIUM_STATE_DIR

describe('machine build report over a live daemon socket', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-build-report-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
  })

  afterAll(async () => {
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
  })

  async function connect(build?: PeerBuild): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/daemon`)
    const dialer = createHandshakeDialer({
      peerRole: 'machine',
      credential: { kind: 'daemonSecret', secret: server.bootstrapToken },
      caps: build ? ['update.delivery.feed'] : [],
      ...(build === undefined ? {} : { build }),
    })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify(dialer.hello())))
      ws.on('error', reject)
      ws.on('message', (raw) => {
        const step = dialer.receive(raw.toString())
        if (step.action === 'established') resolve()
        else if (step.action !== 'deliver') reject(new Error(`handshake ${step.action}`))
      })
    })
    return ws
  }

  async function close(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
    })
  }

  it('accepts an old daemon hello and leaves its build unreported', async () => {
    const ws = await connect()
    const row = server.registry.modules.machines.listMachines()[0]
    expect(row).toMatchObject({
      appVersion: null,
      installKind: null,
      deliveryCaps: [],
      versionState: 'unreported',
    })
    await close(ws)
  })

  it('records a new daemon build report after the real handshake', async () => {
    const ws = await connect({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
    })
    const row = server.registry.modules.machines.listMachines()[0]
    expect(row).toMatchObject({
      appVersion: '0.4.2',
      wireSchemaDigest: 'abc',
      installKind: 'installed',
      deliveryCaps: ['update.delivery.feed'],
    })
    await close(ws)
  })
})
