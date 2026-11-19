// workspace-scoped (POD-6959)
/**
 * THE AUTHORITY'S RECORD SOURCE (POD-6253 design §1 and §3, POD-6920).
 *
 * Every synced kind is built from the model tables by its builder
 * (`record-builders.ts`), and which records a write changed comes from the
 * database's change capture: `drainCapture` takes the rows the capture
 * triggers wrote in the current transaction and maps them to record ids
 * through the kinds' declarations (`record-sources.ts`). The start-up load
 * and the sharing rules read the same builders. There is no copy fallback and
 * no record a writer names.
 *
 * ONE WORKSPACE (POD-7021, POD-6959 design 2.7). Every captured row of a
 * workspace table names its workspace (`record-sources.ts`), and the drain
 * refuses one that is not its transaction's: scoped queries cannot write such
 * a row, so it fails closed rather than append a change to the wrong feed.
 */

import type { MetadataEntityKind } from '@podium/protocol'
import type { CapturedRow, RecordSourcePort } from '@podium/sync'
import { WorkspaceScopeError } from '@podium/sync/adapters/sqlite/prepared'
import { inChangeLogCommit } from '../store/commit-open'
import { currentStoreContext } from '../store/executor/context'
import { spanOpen } from '../store/executor/executor'
import { type RecordReads, serverRecordBuilders } from './record-builders'
import { capturedWorkspace, type RecordSources, touchedRecords } from './record-sources'

/**
 * A captured row of another workspace reached a drain: a write of one
 * workspace's rows ran inside another workspace's transaction (or a global
 * one). Nothing is appended; the transaction fails.
 */
export class ForeignCaptureError extends WorkspaceScopeError {
  override readonly name = 'ForeignCaptureError'
  constructor(
    readonly kind: string,
    readonly capturedWorkspaceId: string,
    readonly transactionWorkspaceId: string | undefined,
  ) {
    super(
      `sync capture: a ${kind} row of workspace ${capturedWorkspaceId} was captured in ` +
        (transactionWorkspaceId === undefined
          ? 'a global transaction'
          : `a transaction of workspace ${transactionWorkspaceId}`) +
        ": its change would reach another workspace's feed",
    )
  }
}

/**
 * Refuse a captured row whose workspace is not `workspaceId` (undefined: a
 * global transaction, which may capture no workspace row). Both keys of an
 * update are checked, so a row moved out of the workspace is refused too.
 */
export function assertCapturedInWorkspace(
  rows: readonly CapturedRow[],
  workspaceId: string | undefined,
  sources?: RecordSources,
): void {
  for (const row of rows) {
    const captured = capturedWorkspace(row, sources)
    if (captured === undefined) continue
    for (const id of [captured.old, captured.new]) {
      if (id !== undefined && id !== workspaceId) {
        throw new ForeignCaptureError(row.kind, id, workspaceId)
      }
    }
  }
}

/**
 * The workspace a drain belongs to: its open transaction's, or (outside one,
 * where the capture is empty anyway) the workspace of the sync repository.
 */
function drainWorkspace(reads: RecordReads): string | undefined {
  const open = currentStoreContext()
  if (open === undefined) return reads.store.sync.workspaceId
  return open.kind === 'workspace' ? open.workspaceId : undefined
}

/**
 * The record source over `reads`. The store's repositories route each
 * statement to the transaction open when it runs, so a drain and a build
 * inside a commit's span see that span's own writes. `kinds` limits a test to
 * a subset; production builds and drains every kind.
 */
export function databaseRecords(
  reads: RecordReads,
  kinds?: readonly MetadataEntityKind[],
): RecordSourcePort {
  const registry = serverRecordBuilders()
  const only = kinds === undefined ? undefined : new Set<MetadataEntityKind>(kinds)
  if (only) for (const kind of only) registry.get(kind)
  return {
    drainCapture: async (after) => {
      const rows = await reads.store.sync.drainCapture(after)
      assertCapturedInWorkspace(rows, drainWorkspace(reads))
      return await touchedRecords(rows, reads, only)
    },
    // Outside a transaction the capture is empty: no statement.
    captureMark: async () => (spanOpen() ? await reads.store.sync.captureMark() : 0),
    inCommit: inChangeLogCommit,
    build: async (kind, ids) => await registry.build(reads, kind, ids),
    buildMany: (idsByKind) => registry.buildMany(reads, idsByKind),
    kinds: () => registry.kinds(),
    streamAll: (kind) => registry.streamAll(reads, kind),
    streamAllKinds: () => registry.streamAllKinds(reads),
  }
}
