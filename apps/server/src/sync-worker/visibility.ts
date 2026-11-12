import type { SqlDatabase } from '@podium/runtime/sqlite'
import { GrantEdgeVisibilityPolicy, NoDelegationsGranted } from '@podium/sync/bootstrap-worker'
import { makeFeedVisibility } from '../feed-visibility'
import { effectPublication } from '../modules/effects/published-input'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import { databaseRecords } from '../sync/record-source'
import { recordReadsOf } from './record-reads'

export interface BootstrapVisibilityOptions {
  /** The effect kinds the server serves: an effect record's published input
   *  depends on them (`modules/effects/published-input.ts`). */
  readonly effectKinds?: readonly string[]
  /** Test fixtures can preserve their record clock without changing deadlines. */
  readonly now?: () => number
}

/**
 * The sharing rules and the record builders over one read-only connection:
 * query repositories only, with no SessionStore, migrations, authority or
 * publication. The caller has already opened the read transaction, so every
 * read below belongs to that snapshot.
 */
export function bootstrapVisibility(
  database: SqlDatabase,
  options: BootstrapVisibilityOptions = {},
) {
  const executor = createBunStoreExecutor({ database })
  const context = (async () => {
    const reads = recordReadsOf(executor.queries, {
      effectExecutors: effectPublication(options.effectKinds ?? []),
      ...(options.now && { now: options.now }),
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
  // Return ownership before the first async read can fail, so the caller always closes it.
  return {
    context,
    get policy() {
      return context.then((value) => value.policy)
    },
    executor,
  }
}
