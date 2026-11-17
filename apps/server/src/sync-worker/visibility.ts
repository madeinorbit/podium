// workspace-scoped (POD-6959)
import type { WorkspaceId } from '@podium/model'
import { GrantEdgeVisibilityPolicy, NoDelegationsGranted } from '@podium/sync/bootstrap-worker'
import { makeFeedVisibility } from '../feed-visibility'
import { effectPublication } from '../modules/effects/published-input'
import type { QueryClient } from '../store/executor/driver'
import type { RootStoreExecutor } from '../store/executor/executor'
import { databaseRecords } from '../sync/record-source'
import { recordReadsOf } from './record-reads'

export interface BootstrapVisibilityOptions {
  /** The effect kinds the server serves: an effect record's published input
   *  depends on them (`modules/effects/published-input.ts`). */
  readonly effectKinds?: readonly string[]
  /** Test fixtures can preserve their record clock without changing deadlines. */
  readonly now?: () => number
  /**
   * The workspace whose records and feed are read (POD-7021); the self-hosted
   * install's when omitted (see `BootstrapJob.workspaceId`).
   */
  readonly workspaceId?: WorkspaceId
}

/**
 * The sharing rules and the record builders over one read session's executor
 * (`read-session.ts`, on either engine): query repositories only, with no
 * SessionStore, migrations, authority or publication. Every statement of that
 * executor runs in the session's read transaction, so every read below belongs
 * to its snapshot. The caller owns the session and closes it.
 */
export function bootstrapVisibility(
  executor: RootStoreExecutor<QueryClient>,
  options: BootstrapVisibilityOptions = {},
) {
  const context = (async () => {
    const reads = recordReadsOf(executor.queries, {
      effectExecutors: effectPublication(options.effectKinds ?? []),
      ...(options.now && { now: options.now }),
      ...(options.workspaceId && { workspaceId: options.workspaceId }),
    })
    const { grants, sync } = reads.store
    // The start-up load streams these, and the sharing rules re-send current
    // values from them (POD-6770): every kind, built from the model tables.
    const records = databaseRecords(reads)
    const visibility = makeFeedVisibility({
      store: reads.store,
      audiencesFor: (kind, ids) => grants.visibilityAudiencesFor(kind, ids),
      // A job-local cache lives only as long as this immutable read snapshot.
      authorizationRevision: () => sync.maxChangeSeq(),
      currentRecords: records.build,
    })
    return {
      policy: new GrantEdgeVisibilityPolicy(visibility.state, new NoDelegationsGranted()),
      anchors: visibility.anchors,
      sync,
      records,
    }
  })()
  return {
    context,
    get policy() {
      return context.then((value) => value.policy)
    },
  }
}
