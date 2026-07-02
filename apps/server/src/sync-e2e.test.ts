import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type MetadataDeltaMessage,
  type ServerMessage,
  type SyncChangesSinceResult,
  WIRE_VERSION,
} from '@podium/protocol'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppRouter } from './router'
import { startServer } from './server'

// End-to-end over the REAL wiring (docs/spec/oplog-read-path.md §5): a booted
// server, real WS upgrades through wsServer's hello parse, and sync.changesSince
// over actual HTTP tRPC — the seams the registry-level tests can't cover.
describe('metadata oplog e2e (live server)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-sync-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
    baseUrl = `http://127.0.0.1:${server.port}`
  })
  afterAll(async () => {
    for (const s of sockets) s.close()
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    delete process.env.PODIUM_STATE_DIR
  })

  function connect(caps?: string[]): { inbox: ServerMessage[]; ready: Promise<void> } {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/client?v=${WIRE_VERSION}`)
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
            ...(caps ? { caps } : {}),
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

  it('delivers deltas to a cap client, snapshots to a legacy one, and heals via tRPC', async () => {
    const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${baseUrl}/trpc` })] })

    const capClient = connect(['metadataDelta'])
    const legacy = connect()
    await capClient.ready
    await legacy.ready
    await until(() => capClient.inbox.some((m) => m.type === 'welcome'))

    // Bootstrap over real HTTP tRPC: null cursor -> snapshot + cursor.
    const boot = (await trpc.sync.changesSince.query({ cursor: null })) as SyncChangesSinceResult
    expect(boot.kind).toBe('snapshot')
    if (boot.kind !== 'snapshot') return

    // A mutation through the real operator path (HTTP tRPC -> IssueService).
    await trpc.issues.create.mutate({ repoPath: '/repo', title: 'e2e issue', startNow: false })

    await until(() => capClient.inbox.some((m) => m.type === 'metadataDelta'))
    const delta = capClient.inbox.find((m) => m.type === 'metadataDelta') as MetadataDeltaMessage
    expect(delta.changes).toHaveLength(1)
    expect(delta.changes[0]).toMatchObject({ entity: 'issue', op: 'upsert' })

    // The legacy socket saw a full issuesChanged and never a delta.
    await until(() =>
      legacy.inbox.some((m) => m.type === 'issuesChanged' && m.issues.length === 1),
    )
    expect(legacy.inbox.some((m) => m.type === 'metadataDelta')).toBe(false)
    // ...and the cap socket never got the issuesChanged rebroadcast (only the
    // attach-time bootstrap, which arrives before hello lands).
    const capListRebroadcasts = capClient.inbox.filter(
      (m) => m.type === 'issuesChanged' && m.issues.length > 0,
    )
    expect(capListRebroadcasts).toHaveLength(0)

    // Heal from the boot cursor: exactly the one issue upsert, cursor advanced.
    const heal = (await trpc.sync.changesSince.query({
      cursor: boot.cursor,
    })) as SyncChangesSinceResult
    expect(heal.kind).toBe('delta')
    if (heal.kind !== 'delta') return
    expect(heal.changes.map((c) => [c.entity, c.op])).toEqual([['issue', 'upsert']])
    expect(heal.cursor).toBe(delta.seq)
  })
})
