import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type FeedDeltaMessage,
  type ServerMessage,
  type SyncChangesSinceResult,
  WIRE_VERSION,
} from '@podium/protocol'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { AppRouter } from './router'
import { startServer } from './server'

// End-to-end over the REAL wiring (docs/spec/oplog-read-path.md §5): a booted
// server, real WS upgrades through wsServer's hello parse, and sync.changesSince
// over actual HTTP tRPC — the seams the registry-level tests can't cover.
const priorStateDir = process.env.PODIUM_STATE_DIR!

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
    process.env.PODIUM_STATE_DIR = priorStateDir
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
            wireVersion: WIRE_VERSION,
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

  it('delivers scoped deltas to a current client and heals via tRPC', async () => {
    const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${baseUrl}/trpc` })] })

    const capClient = connect(['metadataDelta'])
    await capClient.ready
    await until(() => capClient.inbox.some((m) => m.type === 'welcome'))

    // Bootstrap over real HTTP tRPC: null cursor -> snapshot + cursor.
    const boot = (await trpc.sync.changesSince.query({ cursor: null })) as SyncChangesSinceResult
    expect(boot.kind).toBe('snapshot')
    if (boot.kind !== 'snapshot') return

    // A mutation through the real operator path (HTTP tRPC -> IssueService).
    await trpc.issues.create.mutate({ repoPath: '/repo', title: 'e2e issue', startNow: false })

    await until(() => capClient.inbox.some((m) => m.type === 'feedDelta'))
    const delta = capClient.inbox.find((m) => m.type === 'feedDelta') as FeedDeltaMessage
    expect(delta.changes.map((change) => change.entity).sort()).toEqual([
      'issue',
      'issueProjection',
    ])
    expect(delta.changes.every((change) => change.op === 'upsert')).toBe(true)

    // The cap socket never got the issuesChanged rebroadcast. On this server it
    // never gets `issuesChanged` at all — see the POD-1625 case below for why.
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
    expect(heal.changes.map((c) => [c.entity, c.op]).sort()).toEqual([
      ['issue', 'upsert'],
      ['issueProjection', 'upsert'],
    ])
    expect(heal.cursor).toBe(delta.seq)
  })

  /**
   * ONE WORLD PER CONNECTION (POD-1625).
   *
   * A socket is admitted before it has said anything, so `ClientMux` opens it at
   * wire 1 and `hello` moves it to wire 2 a frame later. Read on its own, that
   * sequence says the world is read and sent TWICE per connection — once as v1
   * full lists at attach, once as `feedBootstrap` at `hello` — and
   * `feed-serving.ts` used to accept exactly that cost in a comment.
   *
   * IT CANNOT HAPPEN ON THIS SERVER, and the reason is not the version window:
   * `relay.ts` installs `GrantEdgeVisibilityPolicy` unconditionally, so the
   * authority's grade is `per-principal`, and `WireFeedEdge.attach` refuses any
   * wire that cannot express `evict` — which wire 1 cannot. The pre-hello attach
   * is therefore refused with a 426 and serves nothing, and the world is read
   * once, at `hello`, in the version the peer actually named.
   *
   * THAT MAKES THIS A REAL ASSERTION AND NOT A RESTATEMENT. The property is a
   * consequence of the visibility grade, which lives in a different file for a
   * different reason and could be changed by someone who has never read this
   * one — and the failure would be silent and expensive rather than red. The
   * discriminator is the v1 list messages: after POD-1576 deleted the
   * `publishIssues` tail, `legacy-wire-v1-adapter.ts` is their only producer, so
   * one appearing here means a v1 world was served.
   */
  it('reads and sends its world ONCE per connection, never once per wire version', async () => {
    const client = connect()
    await client.ready
    await until(() => client.inbox.some((m) => m.type === 'feedBootstrap'))
    // Past the point a second, `hello`-triggered world would have landed.
    await new Promise((r) => setTimeout(r, 250))

    expect(client.inbox.filter((m) => m.type === 'feedBootstrap')).toHaveLength(1)
    const v1World = client.inbox.filter((m) =>
      [
        'issuesChanged',
        'conversationsChanged',
        'automationsChanged',
        'automationRunsChanged',
      ].includes(m.type),
    )
    expect(v1World.map((m) => m.type)).toEqual([])
  })
})
