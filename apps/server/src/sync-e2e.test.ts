import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_WIRE_VERSION, type ServerMessage } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { noJanitorWorkerForTests } from './janitor-host'
import { startServer } from './server'

// End-to-end over the REAL wiring (docs/spec/oplog-read-path.md §5): a booted
// server and real WS upgrades through wsServer's hello parse.
const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('metadata oplog e2e (live server)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-sync-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port: 0 })
  })
  afterAll(async () => {
    for (const s of sockets) s.close()
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    process.env.PODIUM_STATE_DIR = priorStateDir
  })

  function connect(caps?: string[]): { inbox: ServerMessage[]; ready: Promise<void> } {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/client?v=${CLIENT_WIRE_VERSION}&cap=sync.http.v1`,
    )
    sockets.push(ws)
    const inbox: ServerMessage[] = []
    ws.on('message', (data) => inbox.push(JSON.parse(String(data)) as ServerMessage))
    const ready = new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'hello',
            clientId: '',
            viewport: { cols: 80, rows: 24, dpr: 1 },
            wireVersion: CLIENT_WIRE_VERSION,
            caps: ['sync.http.v1', ...(caps ?? [])],
          }),
        )
        resolve()
      })
    })
    return { inbox, ready }
  }

  const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('admits the live feed once without pushing an entity world', async () => {
    const client = connect()
    await client.ready
    await until(() => client.inbox.some((m) => m.type === 'feedResume'))
    await new Promise((r) => setTimeout(r, 250))
    expect(client.inbox.filter((m) => m.type === 'feedResume')).toHaveLength(1)
    expect(
      client.inbox.filter((m) =>
        [
          'feedBootstrap',
          'issuesChanged',
          'conversationsChanged',
          'automationsChanged',
          'automationRunsChanged',
        ].includes(m.type),
      ),
    ).toEqual([])
  })
})
