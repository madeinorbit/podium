/** Isolated benchmark host; deliberately not the production auth/daemon assembly. */

import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// The root sync barrel exports unused conformance helpers (POD-4005).
// Bind their framework only; no production collaborator is mocked.
mock.module('vitest', () => ({
  describe() {},
  it() {},
  expect() {},
  beforeEach() {},
  afterAll() {},
}))
const [rootArg, dbArg, arm, readyPath, scale = 'full'] = process.argv.slice(2)
const root = resolve(rootArg),
  dbPath = resolve(dbArg)
const load = (path) => import(pathToFileURL(resolve(root, path)).href)
const require = createRequire(resolve(root, 'apps/server/package.json'))
const { generateCorpus, rowPayload } = await import('./corpus.mjs')
const manifest = await generateCorpus(root, dbPath, { smoke: scale === 'smoke' })
const { openTestStore } = await load('apps/server/src/test-support/open-test-store.ts')
const { Authority, GrantEdgeVisibilityPolicy, NoDelegationsGranted, FeedIdentityRegistry } =
  await load('packages/sync/src/index.ts')
const { SubscriptionRegistry } = await load('packages/protocol/src/index.ts')
const { makeFeedVisibility } = await load('apps/server/src/feed-visibility.ts')
const { WorldIndex } = await load('apps/server/src/modules/world-index/index.ts')
const { FeedServing } = await load('apps/server/src/gateway/feed-serving.ts')
const { userClientPrincipal } = await load('apps/server/src/gateway/client-principal.ts')
const { CLIENT_PLANE_LIVENESS } = await load('apps/server/src/gateway/plane-liveness.ts')
const { NativeGatewaySocket, NATIVE_BACKPRESSURE_LIMIT_BYTES } = await load(
  'apps/server/src/gateway/ws-server.ts',
)
const { OrderedClientSend } = await load('apps/server/src/gateway/ordered-client-send.ts')
const { WriteFunnel } = await load('apps/server/src/modules/funnel.ts')
const { EventBus } = await load('apps/server/src/modules/bus.ts')
const store = await openTestStore(dbPath)
const world = await WorldIndex.load(store)
const { Database } = await import('bun:sqlite')
const checkpointDb = new Database(dbPath)
const initialCheckpoint = checkpointDb.query('PRAGMA wal_checkpoint(TRUNCATE)').get()
if (initialCheckpoint.busy) throw new Error('fixture checkpoint busy before measurement')
const feed = makeFeedVisibility({
  store,
  worldIndex: world.reader,
  audienceResourceIds: () => [],
  audienceFor: () => [],
  issueEventSubjects: () => [],
  authorizationRevision: () => 0,
})
const authority = new Authority({
  store: store.sync,
  now: Date.now,
  transact: (fn) => store.transact(fn),
  visibility: new GrantEdgeVisibilityPolicy(feed.state, new NoDelegationsGranted()),
  anchors: feed.anchors,
})
let identity = { feedId: 'measurement-feed', epoch: 'measurement-epoch' }
const serving = new FeedServing({
  authority,
  subscriptions: new SubscriptionRegistry(),
  diagnostics: () => [],
  identity: new FeedIdentityRegistry(
    {
      readIdentity: async () => identity,
      writeIdentity: async (next) => {
        identity = next
      },
    },
    () => crypto.randomUUID(),
  ),
  retention: { minAvailableSeq: () => store.sync.minChangeSeq() },
  authorizationRevision: () => 0,
})
const funnel = new WriteFunnel({ authority, serving, bus: new EventBus(), onPublished() {} })
const { Hono } = require('hono')
const app = new Hono()
app.post('/checkpoint', (c) =>
  c.json(
    checkpointDb
      .query(
        new URL(c.req.url).searchParams.get('truncate') === '1'
          ? 'PRAGMA wal_checkpoint(TRUNCATE)'
          : 'PRAGMA wal_checkpoint(PASSIVE)',
      )
      .get(),
  ),
)
app.get('/health', (c) => c.json({ ok: true }))
let worker
const workerMetrics = []
const relays = {}
const senders = {}
if (arm === 'after') {
  const { SyncWorkerClient } = await load('apps/server/src/sync-worker/worker-client.ts')
  const { registerSyncRoutes } = await load('apps/server/src/sync/routes.ts')
  worker = new SyncWorkerClient({ dbPath, onMetrics: (m) => workerMetrics.push(m) })
  // Passive observation of the production worker's existing message channel.
  // No replacement stream, reader, queue, credit, or promise chain is introduced.
  worker.worker.on('message', (message) => {
    const state = relays[message.transferId]
    if (!state) return
    if (message.type === 'meta') {
      state.rssAtMetaBytes = process.memoryUsage().rss
      state.metaAt = performance.now()
    }
    if (message.type === 'bytes') {
      state.bytes += message.chunk.byteLength
      state.chunks++
      state.maxChunkBytes = Math.max(state.maxChunkBytes, message.chunk.byteLength)
      state.lastProgressAt = performance.now()
    }
    if (message.type === 'metrics') state.metrics = message.metrics
    if (message.type === 'end' || message.type === 'error') {
      state.complete = true
      state.reason = message.reason
      state.completedAt = performance.now()
    }
  })
  const measuredWorker = {
    bootstrap(input, signal) {
      relays[input.transferId] = {
        principal: input.principal.user,
        bytes: 0,
        chunks: 0,
        complete: false,
        maxChunkBytes: 0,
        startedAt: performance.now(),
      }
      return worker.bootstrap(input, signal)
    },
  }
  registerSyncRoutes(app, {
    authority,
    worker: () => measuredWorker,
    serving,
    principal: async (request) => {
      const id = new URL(request.url).searchParams.get('client') ?? crypto.randomUUID()
      return userClientPrincipal(id, `measurement-reader-${id}`, 'member')
    },
  })
}
// Exercise the actual legacy funnel through a minimal tRPC router. Authentication
// is fixed by this loopback-only fixture; app routing/auth overhead is out of scope.
const { initTRPC } = require('@trpc/server')
const { fetchRequestHandler } = require('@trpc/server/adapters/fetch')
const t = initTRPC.create()
const router = t.router({
  feedChangesSince: t.procedure.query(() =>
    funnel.feedChangesSince(
      { ...identity, seq: manifest.from },
      userClientPrincipal('delta', 'measurement-reader', 'member'),
    ),
  ),
})
app.all('/trpc/*', (c) =>
  fetchRequestHandler({ endpoint: '/trpc', req: c.req.raw, router, createContext: () => ({}) }),
)
app.get('/metrics', (c) =>
  c.json({
    senders: Object.fromEntries(Object.entries(senders).map(([id, sink]) => [id, sink.stats()])),
    relays,
    workerMetrics,
    jobs: worker?.activeJobCount() ?? null,
    manifest,
  }),
)
let writeCount = 0
app.post('/write', async (c) => {
  await store.sync.appendChanges(
    [
      {
        entity: 'repo',
        entityId: 'measurement-repo-0',
        op: 'upsert',
        payload: rowPayload(100000 + writeCount++),
      },
    ],
    Date.now(),
  )
  return c.json({ ok: true })
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request, instance) {
    const url = new URL(request.url)
    if (url.pathname === '/ping' || url.pathname === '/bootstrap-ws') {
      if (
        instance.upgrade(request, {
          data: {
            id: url.searchParams.get('client') ?? crypto.randomUUID(),
            bootstrap: url.pathname === '/bootstrap-ws',
            coding: url.searchParams.get('coding'),
          },
        })
      )
        return
    }
    return app.fetch(request)
  },
  websocket: {
    backpressureLimit: NATIVE_BACKPRESSURE_LIMIT_BYTES,
    closeOnBackpressureLimit: false,
    idleTimeout: 0,
    sendPings: false,
    open(ws) {
      if (!ws.data.bootstrap) return
      const native = new NativeGatewaySocket(ws)
      ws.data.native = native
      const sink = new OrderedClientSend(native, CLIENT_PLANE_LIVENESS)
      senders[ws.data.id] = sink
      sink.enableBootstrapCompression(ws.data.coding === 'zstd')
      ws.data.sink = sink
      const principal = userClientPrincipal(
        ws.data.id,
        `measurement-reader-${ws.data.id}`,
        'member',
      )
      serving.attach(
        {
          id: ws.data.id,
          wireVersion: 2,
          acceptsDelta: true,
          send: sink.send,
          sendSequence: sink.sendSequence,
          terminate: () => ws.terminate(),
        },
        principal,
        principal,
      )
    },
    drain(ws) {
      ws.data.native?.emit('drain')
    },
    message() {},
    close(ws) {
      ws.data.sink?.dispose()
      serving.detach(ws.data.id)
    },
  },
})
writeFileSync(
  readyPath,
  JSON.stringify({ port: server.port, pid: process.pid, manifest, arm, root, dbPath }),
)
