/** Whole-world snapshots for test assertions, including in-memory stores. */
import type * as Model from '@podium/model'
import type { MetadataEntityKind } from '@podium/protocol'
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
  issueBriefs: Model.IssueBriefWire[]
  issueDescriptions: Model.IssueDescriptionWire[]
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
    issueBriefs: values('issueBrief'),
    issueDescriptions: values('issueDescription'),
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

/**
 * Everything `principal` may see, every kind whole: the fixture's world, read
 * in-process by the Authority with the builders the sync worker runs
 * (`bootstrap-worker.bun.test.ts` holds the two to the same rows). The first
 * download is the policy's collections (POD-7085) and kind-named loads are
 * gone (POD-7086), so no wire route streams this any more. `kinds` narrows
 * what the fixture looks at; it is not a request.
 */
export async function worldSnapshot(
  registry: SessionRegistry,
  principal: Parameters<SessionRegistry['changeLedger']['authority']['bootstrap']>[0],
  kinds?: readonly MetadataEntityKind[],
): Promise<Snapshot> {
  const world = await registry.changeLedger.authority.bootstrap(principal)
  const identity = await registry.syncDelta.serving.identity()
  const wanted = kinds === undefined ? undefined : new Set<string>(kinds)
  const snapshot = await snapshotFromBootstrap(
    (async function* () {
      yield {
        ...identity,
        snapshotSeq: world.throughSeq,
        kindTokens: {},
        changes: world.changes.flatMap((change) =>
          change.op === 'upsert' && (wanted === undefined || wanted.has(change.entity))
            ? [{ ...change, payload: change.value }]
            : [],
        ),
        last: true,
      }
    })(),
  )
  return { ...snapshot, minAvailableSeq: await registry.syncDelta.serving.retentionFloor() }
}
