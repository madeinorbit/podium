/** Worker-backed snapshots for test assertions, including in-memory stores. */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as Model from '@podium/model'
import type { MetadataEntityKind, Principal } from '@podium/protocol'
import { type SqlDatabase, serializeDatabase } from '@podium/runtime/sqlite'
import type { BootstrapChunk } from '@podium/sync/replica'
import type { SessionRegistry } from '../relay'

/** Test-only array view of the worker stream, independent of retired wire results. */
type Snapshot = {
  kind: 'snapshot'
  cursor: number
  feedId?: string
  epoch?: string
  minAvailableSeq?: number
  sessions: Model.SessionMeta[]
  sessionUserStates: Model.SessionUserStateWire[]
  machines: Model.MachineProjection[]
  issues: never[]
  issueProjections: Model.SlimIssueProjection[]
  issueBodies: Model.IssueBodiesWire[]
  issuePanelTodos: Model.IssuePanelTodoWire[]
  issuePanelArtifacts: Model.IssuePanelArtifactWire[]
  issuePanelDeferreds: Model.IssuePanelDeferredWire[]
  issuePanelStates: Model.IssuePanelStateWire[]
  issueUserStates: Model.IssueUserStateWire[]
  issueGitStates: Model.IssueGitStateProjection[]
  issueDeps: Model.IssueDepProjection[]
  repos: Model.RepoProjection[]
  shipOrders: Model.ShipOrderProjection[]
  shipLanes: Model.ShipLaneProjection[]
  conversations: Model.ConversationRecordWire[]
  automations: Model.AutomationWire[]
  automationRuns: Model.AutomationRunWire[]
  diagnostics: Model.ConversationDiagnosticWire[]
}

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
    const request = JSON.stringify({
      dbPath: path,
      now: (registry as unknown as { now(): number }).now(),
      principal,
      kinds,
      identity: await registry.syncDelta.serving.identity(),
      floor: await registry.syncDelta.serving.retentionFloor(),
    })
    // The Bun CLI condition reaches its worker too; Vitest's resolver-only
    // condition and Worker.execArgv do not select source exports there.
    const snapshot = await new Promise<Snapshot>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          '--conditions=@podium/source',
          fileURLToPath(new URL('./bootstrap-snapshot-worker.ts', import.meta.url)),
          request,
        ],
        { maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr || error.message, { cause: error }))
          try {
            resolve(JSON.parse(stdout) as Snapshot)
          } catch (error) {
            reject(error)
          }
        },
      )
    })
    return { ...snapshot, minAvailableSeq: await registry.syncDelta.serving.retentionFloor() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
