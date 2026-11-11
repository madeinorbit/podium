/** Bun entry for snapshot fixtures: Vitest's resolver conditions do not reach workers. */

import { HttpBootstrapSource } from '@podium/client-core/sync-stream'
import type { MetadataEntityKind, Principal } from '@podium/protocol'
import { Hono } from 'hono'
import { registerSyncRoutes } from '../sync/routes'
import { SyncWorkerClient } from '../sync-worker/worker-client'
import { snapshotFromBootstrap } from './bootstrap-snapshot'

const input = JSON.parse(process.argv[2] ?? '') as {
  dbPath: string
  now: number
  principal: Principal
  kinds?: MetadataEntityKind[]
  identity: { feedId: string; epoch: string }
  floor: number
}
const worker = new SyncWorkerClient({ dbPath: input.dbPath, recordNow: () => input.now })
try {
  const app = new Hono()
  registerSyncRoutes(app, {
    authority: {
      captureHead: async () => {
        throw new Error('snapshot fixture requested a delta')
      },
      changesRange: () => {
        throw new Error('snapshot fixture requested a delta')
      },
    },
    serving: { identity: () => input.identity, retentionFloor: () => input.floor },
    principal: async () => input.principal,
    worker: () => worker,
  })
  const source = new HttpBootstrapSource({
    origin: 'https://example.test',
    streamingFetch: {
      fetch: async (url, init) => {
        const headers = new Headers(init.headers)
        headers.set('accept-encoding', 'identity')
        const response = await app.fetch(new Request(url, { ...init, headers }))
        if (!response.ok)
          throw new Error(`worker snapshot HTTP ${response.status}: ${await response.text()}`)
        return response
      },
    },
  })
  process.stdout.write(
    JSON.stringify(await snapshotFromBootstrap(source.bootstrap(undefined, input.kinds))),
  )
} finally {
  await worker.close()
}
