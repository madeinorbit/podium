/** Worker-backed snapshots for test assertions, including in-memory stores. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpBootstrapSource } from '@podium/client-core/sync-stream'
import type { MetadataEntityKind, Principal, SyncChangesSinceResult } from '@podium/protocol'
import { type SqlDatabase, serializeDatabase } from '@podium/runtime/sqlite'
import type { BootstrapChunk } from '@podium/sync/replica'
import { Hono } from 'hono'
import type { SessionRegistry } from '../relay'
import { registerSyncRoutes } from '../sync/routes'
import { SyncWorkerClient } from '../sync-worker/worker-client'

type Snapshot = Extract<SyncChangesSinceResult, { kind: 'snapshot' }>

/** Keep the test fixture's array vocabulary; records are built/scoped in the worker. */
export async function snapshotFromBootstrap(
  chunks: AsyncIterable<BootstrapChunk>,
): Promise<Snapshot> {
  const rows = new Map<string, unknown[]>()
  let head: BootstrapChunk | undefined
  for await (const chunk of chunks) {
    head = chunk
    for (const change of chunk.changes) {
      let values = rows.get(change.entity)
      if (!values) {
        values = []
        rows.set(change.entity, values)
      }
      values.push(change.payload)
    }
  }
  if (!head?.last) throw new Error('worker bootstrap did not complete')
  const values = <T>(entity: MetadataEntityKind): T[] => (rows.get(entity) ?? []) as T[]
  return {
    kind: 'snapshot',
    cursor: head.snapshotSeq,
    feedId: head.feedId,
    epoch: head.epoch,
    sessions: values('session'),
    sessionUserStates: values('sessionUserState'),
    machines: values('machine'),
    issues: [],
    issueProjections: values('issueProjection'),
    issueBodies: values('issueBodies'),
    issuePanelTodos: values('issuePanelTodo'),
    issuePanelArtifacts: values('issuePanelArtifact'),
    issuePanelDeferreds: values('issuePanelDeferred'),
    issuePanelStates: values('issuePanelState'),
    issueUserStates: values('issueUserState'),
    issueGitStates: values('issueGitState'),
    issueDeps: values('issueDep'),
    repos: values('repo'),
    shipOrders: values('shipOrder'),
    shipLanes: values('shipLane'),
    conversations: values('conversation'),
    automations: values('automation'),
    automationRuns: values('automationRun'),
    diagnostics: [],
  }
}

export async function workerSnapshot(
  registry: SessionRegistry,
  principal: Principal,
  kinds?: readonly MetadataEntityKind[],
): Promise<Snapshot> {
  const dir = mkdtempSync(join(tmpdir(), 'worker-test-snapshot-'))
  let worker: SyncWorkerClient | undefined
  try {
    const path = join(dir, 'snapshot.db')
    // Test-only access to the fixture's physical image. The exclusive lane
    // captures memory and file stores consistently without building any records.
    const physical = registry.sessionStore as unknown as {
      db: SqlDatabase
      executor: { exclusive<T>(read: () => Promise<T>): Promise<T> }
    }
    await physical.executor.exclusive(async () => {
      writeFileSync(path, serializeDatabase(physical.db))
    })
    worker = new SyncWorkerClient({ dbPath: path })
    const app = new Hono()
    registerSyncRoutes(app, {
      ...registry.syncDelta,
      principal: async () => principal,
      worker: () => worker,
    })
    const source = new HttpBootstrapSource({
      origin: 'https://example.test',
      streamingFetch: {
        fetch: async (url, init) => {
          const headers = new Headers(init.headers)
          headers.set('accept-encoding', 'identity')
          return await app.fetch(new Request(url, { ...init, headers }))
        },
      },
    })
    return await snapshotFromBootstrap(source.bootstrap(undefined, kinds))
  } finally {
    await worker?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
