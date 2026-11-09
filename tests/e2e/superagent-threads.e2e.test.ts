/**
 * MY SUPERAGENT THREADS ACROSS MY DEVICES, AGAINST A REAL SERVER (POD-6675).
 *
 * A superagent thread is a synced record of its owner (design POD-5620 §1.7).
 * The thread list used to be one `superagent.listThreads` read at startup, so a
 * thread made on another device never appeared. This file checks the product
 * claim end to end on the real stack, composed as the per-user records e2e
 * (POD-6673) composes a device: HTTP bootstrap and delta sources, a real
 * WebSocket into `FeedSink`, the kernel `Replica` over IndexedDB and the kernel
 * outbox.
 *
 *  - The server makes my global thread; both of my devices hold it from their
 *    first bootstrap, and no read made it.
 *  - A thread created by a superagent command on device A, and its rename (a
 *    queued generic edit A sends once online), reach device B as feed deltas,
 *    without B reloading.
 *  - The server's turn status (`turnRunning`) reaches B while the turn runs,
 *    and clears there when it ends.
 *  - Another member, connected throughout, never receives any of it. The
 *    positive control is the member's own thread, which does reach them.
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { OutboxEntry, OutboxStorage } from '@podium/client-core/outbox'
import { recordEditEntry } from '@podium/client-core/records'
import type { Replica as ClientReplica } from '@podium/client-core/replica'
import { FeedSink } from '@podium/client-core/replica/feed'
import { HttpBootstrapSource, HttpDeltaSource } from '@podium/client-core/sync-stream'
import {
  asMutationId,
  asThreadId,
  asUserId,
  firstAdminMemberId,
  superagentThreadRowId,
  type UserId,
} from '@podium/model'
import {
  CAP_SYNC_HTTP_V1,
  CAP_TOPICS_V1,
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
import { hashToken } from '../../apps/server/src/auth-route'
import type { AppRouter } from '../../apps/server/src/router'
import { startServer } from '../../apps/server/src/server'
// The kernel queue alone: the engine's index also loads the decorated client
// models, which this node lane does not transform.
import { openKernelEngineOutbox } from '../../packages/client-core/src/engine/kernel-outbox'

const FEED_TYPES = new Set(['feedDelta', 'feedRescope', 'feedResyncRequired'])
const THREAD_KIND = 'superagentThread'
const priorStateDir = process.env.PODIUM_STATE_DIR
const priorMode = process.env.PODIUM_MODE

const MEMBER = asUserId('usr_member_6675_e2e')

describe('POD-6675 · my superagent threads on my other device (live server)', () => {
  let stateDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  /** The instance's first admin: me, the person with two devices. */
  let ME: UserId
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-threads-e2e-'))
    process.env.PODIUM_STATE_DIR = stateDir
    // A configured server: an unconfigured one refuses clients until setup.
    process.env.PODIUM_MODE = 'server'
    server = await startServer({ port: 0 })
    ME = await firstAdminMemberId(server.registry.sessionStore)
    await server.registry.sessionStore.users.createUnclaimed({
      id: MEMBER,
      displayName: 'Member',
      email: null,
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    })
  })

  afterAll(async () => {
    for (const s of sockets) s.close()
    await server.close()
    rmSync(stateDir, { recursive: true, force: true })
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorMode === undefined) delete process.env.PODIUM_MODE
    else process.env.PODIUM_MODE = priorMode
  })

  const until = async (pred: () => boolean, ms = 8000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for condition')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  /** A signed-in device: its own session cookie for `user`, as a login sets. */
  async function signIn(user: UserId): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const expires = new Date(Date.now() + 3_600_000).toISOString()
    await server.registry.sessionStore.auth.createClientSession(hashToken(token), user, expires)
    return token
  }

  const trpcFor = (token: string) =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `http://127.0.0.1:${server.port}/trpc`,
          headers: { cookie: `podium_session=${token}` },
        }),
      ],
    })

  const memoryStorage = (): OutboxStorage => {
    let entries: OutboxEntry[] = []
    return {
      load: () => entries,
      save: (next) => {
        entries = [...next]
      },
    }
  }

  interface Device {
    readonly replica: Replica
    readonly trpc: ReturnType<typeof trpcFor>
    readonly framesSeen: string[]
    /** This device's queue, as the engine holds it. */
    readonly outbox: ReturnType<Awaited<ReturnType<typeof openKernelEngineOutbox>>>
    readonly dropped: OutboxEntry[]
    goOnline(): void
    /** The superagent thread records this device holds, by feed id. */
    threads(): Map<string, Record<string, unknown>>
  }

  /** One signed-in device, composed as `openReplicaAssembly` composes it. */
  async function openDevice(name: string, user: UserId): Promise<Device> {
    const token = await signIn(user)
    const trpc = trpcFor(token)
    const api = trpc as unknown as PodiumClientApi
    const store = await IndexedDbSyncStore.open({
      factory: new IDBFactory() as unknown as IdbFactoryLike,
      databaseName: `threads-e2e-${name}`,
      onDegraded: (d) => {
        throw new Error(`storage degraded during the e2e: ${JSON.stringify(d)}`)
      },
    })
    const view = store.viewFor(user)
    let replica: Replica | undefined
    const queue = await openKernelEngineOutbox({
      store: view.outbox,
      principal: user,
      api,
      onDegraded: (detail) => {
        throw new Error(`outbox degraded: ${JSON.stringify(detail)}`)
      },
      confirmedThrough: () => replica?.cursor ?? null,
    })
    const sourceDeps = {
      origin: `http://127.0.0.1:${server.port}`,
      streamingFetch: { fetch, headers: () => ({ cookie: `podium_session=${token}` }) },
    }
    const bootstraps = new HttpBootstrapSource(sourceDeps)
    const deltas = new HttpDeltaSource(sourceDeps)
    const kernel = new Replica({
      store: view.cache,
      authority: {
        bootstrap: (signal) => bootstraps.bootstrap(signal),
        changesRange: (cursor, signal, onTarget) => deltas.changesRange(cursor, signal, onTarget),
      },
      // Write confirmation: a commit that reaches an entry's receipt retires it.
      overlay: queue.overlay,
      unitOfWork: store.unitOfWork,
    })
    replica = kernel
    const framesSeen: string[] = []
    const sink = new FeedSink({ replica: kernel, onFrame: (kind) => framesSeen.push(kind) })

    let online = false
    const dropped: OutboxEntry[] = []
    const outbox = queue({
      api,
      replica: {
        outboxStorage: memoryStorage,
        outboxAwaitingStorage: memoryStorage,
        outboxDeadLetterStorage: memoryStorage,
      } as unknown as ClientReplica,
      notices: { error: () => {}, info: () => {} } as never,
      isOnline: () => online,
      onDropped: (entry) => dropped.push(entry),
    })

    // The URL and the hello the socket hub sends: the version range and the
    // HTTP-sync capability a feed client advertises before and after upgrade.
    const url = `ws://127.0.0.1:${server.port}/client?v=${CLIENT_WIRE_VERSION}&vmin=${MIN_CLIENT_WIRE_VERSION}&cap=${CAP_SYNC_HTTP_V1}`
    const ws = new WebSocket(url, {
      headers: { cookie: `podium_session=${token}` },
    })
    sockets.push(ws)
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
            caps: [CAP_TOPICS_V1, CAP_SYNC_HTTP_V1],
            ...(sink.helloFields() ?? {}),
          }),
        )
        resolve()
      })
    })
    sink.connected(false)
    await until(() => kernel.cursor !== null)
    await kernel.settled()
    return {
      replica: kernel,
      trpc,
      framesSeen,
      outbox,
      dropped,
      goOnline: () => {
        online = true
      },
      threads: () =>
        new Map(
          kernel
            .entities()
            .filter((row) => row.entity === THREAD_KIND)
            .map((row) => [row.entityId, row.value as Record<string, unknown>]),
        ),
    }
  }

  it('a thread made and renamed on A, and its running turn, reach B and never another member', async () => {
    const a = await openDevice('me-a', ME)
    const b = await openDevice('me-b', ME)
    const member = await openDevice('member', MEMBER)

    // THE SERVER MADE MY GLOBAL THREAD: on both of my devices from bootstrap.
    const global = superagentThreadRowId(ME, 'global')
    expect(a.threads().get(global)).toMatchObject({ kind: 'global', turnRunning: false })
    expect(b.threads().get(global)).toMatchObject({ kind: 'global' })

    // A CREATES A THREAD by a superagent command: B receives it as a delta.
    const { threadId } = await a.trpc.superagent.startBtw.mutate({
      sessionId: '00000000-0000-4000-8000-0000000066a5',
    } as never)
    const btw = superagentThreadRowId(ME, threadId)
    await until(() => b.threads().has(btw))
    expect(b.framesSeen).toContain('feedDelta')
    expect(b.threads().get(btw)).toMatchObject({ kind: 'btw', archived: false })

    // A RENAMES IT OFFLINE: queued, sent nothing, then drained once online.
    await a.outbox.enqueue(
      'recordEdit',
      recordEditEntry({ kind: 'superagentThread', id: btw }, { title: 'Renamed on A' }),
      { mutationId: asMutationId('e2e-thread-rename') },
    )
    await a.outbox.drain()
    expect(a.outbox.pending().map((e) => e.mutationId)).toEqual(['e2e-thread-rename'])
    expect(b.threads().get(btw)?.title).not.toBe('Renamed on A')
    a.goOnline()
    await a.outbox.drain()
    await until(() => b.threads().get(btw)?.title === 'Renamed on A')
    expect(a.dropped).toEqual([])
    await until(() => a.outbox.pending().length === 0 && a.outbox.awaiting().length === 0)

    // A TURN RUNS: the server's status reaches B, and clears there at its end.
    const store = server.registry.sessionStore
    await store.superagent.setTurnRunning(asThreadId('global'), true, { clearFailure: true })
    await until(() => b.threads().get(global)?.turnRunning === true)
    await store.superagent.setTurnRunning(asThreadId('global'), false)
    await until(() => b.threads().get(global)?.turnRunning === false)

    // ANOTHER MEMBER NEVER RECEIVES MINE. Positive control first: a thread the
    // server makes for the member reaches the member's device.
    await store.superagent.upsertSuperagentThread({
      id: 'btw_member-6675',
      ownerUserId: MEMBER,
      kind: 'btw',
    })
    const theirs = superagentThreadRowId(MEMBER, 'btw_member-6675')
    await until(() => member.threads().has(theirs))
    await member.replica.settled()
    for (const id of [global, btw]) expect(member.threads().has(id)).toBe(false)
    // And theirs stays theirs.
    expect(b.threads().has(theirs)).toBe(false)
  })
})
