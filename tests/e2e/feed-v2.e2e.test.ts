/**
 * Current feed transport against a real server and durable IndexedDB replicas.
 * Clients authenticate with their own device cookie, pull the initial policy
 * over HTTP, then receive live WebSocket deltas. Reconnecting clients must
 * converge with each other and with a fresh authority bootstrap, while their
 * cached rows stay visible during the outage.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeedSink } from '@podium/client-core/replica/feed'
import { HttpBootstrapSource, HttpDeltaSource } from '@podium/client-core/sync-stream'
import type { UserId } from '@podium/model'
import {
  CAP_SYNC_HTTP_V1,
  CLIENT_WIRE_VERSION,
  MIN_CLIENT_WIRE_VERSION,
  type ServerMessage,
} from '@podium/protocol'
import { type IdbFactoryLike, IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { Replica } from '@podium/sync/replica'
import type { FeedServerFrame } from '@podium/terminal-client'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { AppRouter } from '../../apps/server/src/router'
import { startSyncWorkerTestServer } from '../../apps/server/src/test-support/sync-worker-server'

const FEED_TYPES = new Set(['feedDelta', 'feedResume', 'feedRescope', 'feedResyncRequired'])

const priorStateDir = process.env.PODIUM_STATE_DIR
const priorMode = process.env.PODIUM_MODE

describe('POD-376 · wire v2 feed into the kernel replica (live server)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startSyncWorkerTestServer>>
  let baseUrl: string
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  let factory: IdbFactoryLike
  let owner: UserId
  let cookie: string
  const sockets: WebSocket[] = []
  const clients: LiveClient[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-feed-v2-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    process.env.PODIUM_MODE = 'server'
    server = await startSyncWorkerTestServer({ stateDir, repos: ['/repo'] })
    owner = server.owner
    cookie = server.cookie
    baseUrl = `http://127.0.0.1:${server.port}`
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${baseUrl}/trpc`, headers: { cookie } })],
    })
    factory = new IDBFactory() as unknown as IdbFactoryLike
  })

  afterAll(async () => {
    for (const client of clients) client.goOffline()
    for (const s of sockets) s.close()
    await server.close()
    for (const client of clients) client.store.close()
    rmSync(stateDir, { recursive: true, force: true })
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorMode === undefined) delete process.env.PODIUM_MODE
    else process.env.PODIUM_MODE = priorMode
  })

  const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  interface LiveClient {
    readonly replica: Replica
    readonly store: IndexedDbSyncStore
    readonly framesSeen: string[]
    keys(): string[]
    goOffline(): void
    goOnline(): Promise<void>
  }

  /** One client: real socket announcing wire v2, real consumer, real IndexedDB. */
  async function openClient(name: string): Promise<LiveClient> {
    const store = await IndexedDbSyncStore.open({
      factory,
      databaseName: `feed-e2e-${name}`,
      onDegraded: (d) => {
        throw new Error(`storage degraded during the e2e: ${JSON.stringify(d)}`)
      },
    })
    const view = store.viewFor(owner)
    const framesSeen: string[] = []
    let bootstrapFailure: string | undefined
    let socket: WebSocket | undefined

    const sourceDeps = {
      origin: baseUrl,
      streamingFetch: { fetch, headers: () => ({ cookie }) },
    }
    const bootstraps = new HttpBootstrapSource(sourceDeps)
    const deltas = new HttpDeltaSource(sourceDeps)
    const replica = new Replica({
      store: view.cache,
      onEvent: (event) => {
        if (event.type === 'bootstrap-failed') bootstrapFailure = event.error
      },
      authority: {
        async *bootstrap(signal, policy) {
          framesSeen.push('httpBootstrap')
          yield* bootstraps.bootstrap(signal, policy)
        },
        changesRange: (cursor, signal, onTarget) => deltas.changesRange(cursor, signal, onTarget),
      },
    })
    const sink = new FeedSink({
      replica,
      onFrame: (kind) => framesSeen.push(kind),
    })

    async function openSocket(): Promise<void> {
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/client?v=${CLIENT_WIRE_VERSION}&vmin=${MIN_CLIENT_WIRE_VERSION}&cap=${CAP_SYNC_HTTP_V1}`,
        { headers: { cookie } },
      )
      sockets.push(ws)
      socket = ws
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as ServerMessage
        if (!FEED_TYPES.has(message.type)) return
        sink.frame(message as FeedServerFrame)
      })
      await new Promise<void>((resolve, reject) => {
        ws.on('error', reject)
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'hello',
              clientId: '',
              viewport: { cols: 80, rows: 24, dpr: 1 },
              wireVersion: CLIENT_WIRE_VERSION,
              wireVersionMin: MIN_CLIENT_WIRE_VERSION,
              caps: [CAP_SYNC_HTTP_V1],
              ...(sink.helloFields() ?? {}),
            }),
          )
          resolve()
        })
      })
      sink.connected()
    }

    await openSocket()
    await until(() => {
      if (bootstrapFailure) throw new Error(`HTTP bootstrap failed: ${bootstrapFailure}`)
      return (
        replica.cursor !== null && replica.posture !== 'cold' && replica.posture !== 'bootstrapping'
      )
    })
    const client: LiveClient = {
      replica,
      store,
      framesSeen,
      keys: () =>
        replica
          .entities()
          .map((row) => `${row.entity}:${row.entityId}`)
          .sort(),
      goOffline: () => {
        socket?.close()
        sink.disconnected()
      },
      goOnline: openSocket,
    }
    clients.push(client)
    return client
  }

  /** `(entity, entityId)` keys the AUTHORITY says this principal's slice holds. */
  async function authoritySlice(): Promise<{ keys: string[]; seq: number }> {
    const source = new HttpBootstrapSource({
      origin: baseUrl,
      streamingFetch: { fetch, headers: () => ({ cookie }) },
    })
    const keys: string[] = []
    let seq = 0
    for await (const chunk of source.bootstrap()) {
      seq = chunk.snapshotSeq
      for (const row of chunk.changes) keys.push(`${row.entity}:${row.entityId}`)
    }
    return { keys: keys.sort(), seq }
  }

  it('a current peer pulls its HTTP bootstrap and installs the authority slice', async () => {
    await trpc.issues.create.mutate({ repoPath: '/repo', title: 'first', startNow: false })

    const client = await openClient('primary')
    await until(() => client.framesSeen.includes('httpBootstrap'))
    await client.replica.settled()
    await client.store.settled()

    expect(client.framesSeen).toContain('httpBootstrap')
    expect(client.framesSeen).not.toContain('feedBootstrap')
    expect(client.replica.cursor).not.toBeNull()
    // Feed identity arrived from the authority rather than being synthesised —
    // the whole reason a v2 client can persist a cursor at all (ADR 2 D1).
    expect(client.replica.cursor?.feedId).toBeTruthy()
    expect(client.replica.cursor?.epoch).toBeTruthy()

    const slice = await authoritySlice()
    expect(slice.keys.length).toBeGreaterThan(0)
    await until(() => (client.replica.cursor?.seq ?? -1) >= slice.seq)
    await client.replica.settled()
    expect(client.keys()).toEqual(slice.keys)
  })

  it('a live write reaches a connected v2 replica as a delta', async () => {
    const client = await openClient('live')
    await until(() => client.framesSeen.includes('httpBootstrap'))
    await client.replica.settled()
    const before = client.keys().length

    await trpc.issues.create.mutate({ repoPath: '/repo', title: 'live write', startNow: false })
    await until(() => client.keys().length > before, 8000)
    await client.replica.settled()

    expect(client.framesSeen).toContain('feedDelta')
    const slice = await authoritySlice()
    await until(() => (client.replica.cursor?.seq ?? -1) >= slice.seq)
    await client.replica.settled()
    expect(client.keys()).toEqual(slice.keys)
  })

  it('offline write window → reconnect → both clients converge on the authority slice', async () => {
    const a = await openClient('converge-a')
    const b = await openClient('converge-b')
    await until(
      () => a.framesSeen.includes('httpBootstrap') && b.framesSeen.includes('httpBootstrap'),
    )
    await a.replica.settled()
    await b.replica.settled()

    // A GOES OFFLINE. Its slice stays VISIBLE — D7's stale-visible rule, and the
    // assertion is that the rows are still there, not merely that a posture flag
    // flipped: a replica that blanked on disconnect would satisfy the posture
    // check and fail the product.
    const heldWhileOffline = a.keys()
    a.goOffline()
    expect(a.replica.posture).toBe('stale')
    expect(a.keys()).toEqual(heldWhileOffline)

    // The world moves without A.
    await trpc.issues.create.mutate({
      repoPath: '/repo',
      title: 'while a was away',
      startNow: false,
    })
    await until(() => b.keys().length > heldWhileOffline.length, 8000)

    // A COMES BACK. It resumes from its persisted cursor rather than re-reading
    // the world — which is the point of persisting a real cursor at all.
    await a.goOnline()
    await until(() => a.keys().length === b.keys().length, 8000)
    await a.replica.settled()
    await b.replica.settled()

    const slice = await authoritySlice()
    // CONVERGENCE, AGAINST THE AUTHORITY AND NOT ONLY AGAINST EACH OTHER. Two
    // clients agreeing on the wrong slice is not convergence, and a two-way diff
    // cannot tell the difference.
    await until(() => [a, b].every((client) => (client.replica.cursor?.seq ?? -1) >= slice.seq))
    await Promise.all([a.replica.settled(), b.replica.settled()])
    expect(a.keys()).toEqual(slice.keys)
    expect(b.keys()).toEqual(slice.keys)
    expect(a.replica.posture).not.toBe('cold')
  })

  it('the server advertises its visibility grade on the pre-boot probe', async () => {
    // The client resolves its replica-path flag from this, before any socket
    // exists. A server that did not report it would leave the flag deciding in
    // the dark — and would report `undefined`, which the resolver reads as
    // permissive, so the absence has to be caught here rather than downstream.
    const probe = (await (await fetch(`${baseUrl}/version`)).json()) as { feedScoping?: string }
    expect(probe.feedScoping).toBe('per-principal')
  })
})
