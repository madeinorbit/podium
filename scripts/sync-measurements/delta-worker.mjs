/** Paired worker-delta host. Run with Bun 1.4.2; baseline route is supplied explicitly. */
import { mock } from 'bun:test'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
mock.module('vitest', () => ({ describe() {}, it() {}, expect() {}, beforeEach() {}, afterAll() {} }))
const [dbPath, readyPath, baselinePath] = process.argv.slice(2)
const root = resolve(import.meta.dirname, '../..')
const { generateCorpus } = await import('./corpus.mjs')
const manifest = await generateCorpus(root, dbPath)
const { openTestStore } = await import('../../apps/server/src/test-support/open-test-store.ts')
const { Authority, GrantEdgeVisibilityPolicy, NoDelegationsGranted, DEVICE_GRADE_PRINCIPAL } = await import('../../packages/sync/src/index.ts')
const { makeFeedVisibility } = await import('../../apps/server/src/feed-visibility.ts')
const { WorldIndex } = await import('../../apps/server/src/modules/world-index/index.ts')
const { SyncWorkerClient } = await import('../../apps/server/src/sync-worker/worker-client.ts')
const { registerSyncRoutes } = await import(baselinePath ? pathToFileURL(resolve(baselinePath)).href : '../../apps/server/src/sync/routes.ts')
const require = createRequire(resolve(root, 'apps/server/package.json'))
const { Hono } = require('hono')
const store = await openTestStore(dbPath)
const world = await WorldIndex.load(store)
const feed = makeFeedVisibility({ store, worldIndex: world.reader,
  audienceResourceIds: kind => store.grants.visibilityAudienceResourceIds(kind),
  audienceFor: (kind, id) => store.grants.visibilityAudienceFor(kind, id),
  authorizationRevision: () => store.grants.visibilityRevision(), issueEventSubjects: () => [] })
const authority = new Authority({ store: store.sync, now: Date.now, transact: fn => store.transact(fn),
  visibility: new GrantEdgeVisibilityPolicy(feed.state, new NoDelegationsGranted()), anchors: feed.anchors })
const worker = new SyncWorkerClient({ dbPath })
while (worker.state() !== 'running') await Bun.sleep(10)
const app = new Hono()
registerSyncRoutes(app, { authority, serving: { identity: async () => ({ feedId: 'f', epoch: 'e' }), retentionFloor: () => store.sync.minChangeSeq() },
  worker: () => worker, principal: async () => DEVICE_GRADE_PRINCIPAL })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
writeFileSync(readyPath, JSON.stringify({ pid: process.pid, port: server.port, manifest, bun: Bun.version }))
process.on('SIGTERM', async () => { await server.stop(true); await worker.close(); await store.close(); process.exit(0) })
