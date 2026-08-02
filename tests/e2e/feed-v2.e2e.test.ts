/**
 * POD-376 — THE CUTOVER, AGAINST A REAL SERVER.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND HONESTLY WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * A booted server, a real WebSocket upgrade through the gateway's own `hello`
 * parse, real HTTP tRPC, and on the client side the SHIPPED consumer — `FeedSink`,
 * `frames.ts`, `PushedBootstrapSource`, `FeedAuthorityClient` — driving a real
 * kernel `Replica` over a real `IndexedDbSyncStore`. Nothing between the two ends
 * is a fixture: the frames on this socket are the bytes the server sends, and the
 * rows in the store are what IndexedDB committed.
 *
 * IT IS NOT THE REAL UI, and that distinction is the honest one to make rather
 * than blur. The repo convention for a changed read path is verification in the
 * running app, and the engine swap that would put this consumer behind the app's
 * read model waits on POD-377's store-neutral client Replica facade
 * (`packages/client-core/src/replica/`, claimed by that issue and not on this
 * branch). What is verified here is the seam this issue actually built: the wire
 * cutover, end to end, on the real stack. `docs/agents/pod-376-shadow-comparison-basis.md`
 * §5 records the split; the issue's handoff repeats it rather than letting a green
 * suite imply more than it proves.
 *
 * ---------------------------------------------------------------------------
 * THE OFFLINE → RECONNECT → CONVERGE CHECK
 * ---------------------------------------------------------------------------
 *
 * The brief's standing check, run at this seam: a client goes offline, the world
 * moves without it, it reconnects, and a SECOND client of the same principal ends
 * up holding the same slice. The convergence assertion compares the two clients'
 * stores to each other AND to the authority's own slice (`sync.feedSlice`), which
 * is the comparison basis rather than a two-way diff — two clients agreeing on the
 * wrong answer is not convergence.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FeedAuthorityClient,
  FeedSink,
  PushedBootstrapSource,
} from '@podium/client-core/replica/feed'
import { type ServerMessage, WIRE_VERSION } from '@podium/protocol'
import { IndexedDbSyncStore, type IdbFactoryLike } from '@podium/sync/adapters/indexeddb'
import { Replica } from '@podium/sync/replica'
import type { FeedServerFrame } from '@podium/terminal-client'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { IDBFactory } from 'fake-indexeddb'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppRouter } from '../../apps/server/src/router'
import { startServer } from '../../apps/server/src/server'

const FEED_TYPES = new Set(['feedDelta', 'feedBootstrap', 'feedRescope', 'feedResyncRequired'])

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('POD-376 · wire v2 feed into the kernel replica (live server)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  let factory: IdbFactoryLike
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-feed-v2-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    server = await startServer({ port: 0 })
    baseUrl = `http://127.0.0.1:${server.port}`
    trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${baseUrl}/trpc` })] })
    factory = new IDBFactory() as unknown as IdbFactoryLike
  })

  afterAll(async () => {
    for (const s of sockets) s.close()
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    process.env.PODIUM_STATE_DIR = priorStateDir
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
    const view = store.viewFor('default')
    const framesSeen: string[] = []
    let socket: WebSocket | undefined

    const bootstraps = new PushedBootstrapSource({
      // THE REAL MECHANISM: the server pushes bootstraps and cannot be asked for
      // one, so a re-bootstrap is a reconnect. Here that is an actual socket
      // cycle against the running server, not a callback that fabricates a world.
      requestFreshWorld: () => {
        socket?.close()
        void openSocket()
      },
    })

    const replica = new Replica({
      store: view.cache,
      authority: new FeedAuthorityClient({
        fetchChangesSince: async (cursor) =>
          (await trpc.sync.feedChangesSince.query({ cursor })) as never,
        bootstraps,
      }),
    })
    const sink = new FeedSink({
      replica,
      bootstraps,
      onFrame: (kind) => framesSeen.push(kind),
    })

    async function openSocket(): Promise<void> {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/client?v=${WIRE_VERSION}`)
      sockets.push(ws)
      socket = ws
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as ServerMessage
        // The gateway serves a peer at wire 1 until `hello` lands, so the first
        // messages on any socket are v1 lists. A v2 client ignores them — and
        // ignoring them is correct rather than lossy, because `renegotiate` then
        // re-serves the world in the version this peer actually announced.
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
              // THE ADVERTISEMENT. Without this field the server resolves the v1
              // edge adapter and not one feed frame arrives — which is exactly
              // what the shipped build does today with the flag off.
              wireVersion: WIRE_VERSION,
            }),
          )
          resolve()
        })
      })
      sink.connected()
    }

    await openSocket()
    return {
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
  }

  /** `(entity, entityId)` keys the AUTHORITY says this principal's slice holds. */
  async function authoritySlice(): Promise<string[]> {
    const slice = await trpc.sync.feedSlice.query({})
    return slice.rows.map((r) => `${r.entity}:${r.entityId}`).sort()
  }

  it('a v2 peer is served feed frames, and the kernel replica installs the authority slice', async () => {
    await trpc.issues.create.mutate({ repoPath: '/repo', title: 'first', startNow: false })

    const client = await openClient('primary')
    await until(() => client.framesSeen.includes('feedBootstrap'))
    await client.replica.settled()
    await client.store.settled()

    // FRAMES, NOT LISTS. If the server had resolved the v1 adapter for this peer
    // the array would be empty and every assertion below would be about a replica
    // nothing ever fed.
    expect(client.framesSeen).toContain('feedBootstrap')
    expect(client.replica.cursor).not.toBeNull()
    // Feed identity arrived from the authority rather than being synthesised —
    // the whole reason a v2 client can persist a cursor at all (ADR 2 D1).
    expect(client.replica.cursor?.feedId).toBeTruthy()
    expect(client.replica.cursor?.epoch).toBeTruthy()

    const slice = await authoritySlice()
    expect(slice.length).toBeGreaterThan(0)
    expect(client.keys()).toEqual(slice)
  })

  it('a live write reaches a connected v2 replica as a delta', async () => {
    const client = await openClient('live')
    await until(() => client.framesSeen.includes('feedBootstrap'))
    await client.replica.settled()
    const before = client.keys().length

    await trpc.issues.create.mutate({ repoPath: '/repo', title: 'live write', startNow: false })
    await until(() => client.keys().length > before, 8000)
    await client.replica.settled()

    expect(client.framesSeen).toContain('feedDelta')
    expect(client.keys()).toEqual(await authoritySlice())
  })

  it('offline write window → reconnect → both clients converge on the authority slice', async () => {
    const a = await openClient('converge-a')
    const b = await openClient('converge-b')
    await until(
      () => a.framesSeen.includes('feedBootstrap') && b.framesSeen.includes('feedBootstrap'),
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
    expect(a.keys()).toEqual(slice)
    expect(b.keys()).toEqual(slice)
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
