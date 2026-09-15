import type { SqlDatabase } from '@podium/runtime/sqlite'
import { GrantEdgeVisibilityPolicy, NoDelegationsGranted, SyncRepository } from '@podium/sync/bootstrap-worker'
import { makeFeedVisibility } from '../feed-visibility'
import { syncServerTables } from '../migrations/sync-server-tables'
import type { WorldIndexReader } from '../modules/world-index'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import { IssuesRepository } from '../store/issues'
import { SessionsRepository } from '../store/sessions'
import { ShippingRepository } from '../store/shipping'
import { AutomationsRepository } from '../store/automations'
import { GrantsRepository, type GrantRow } from '../store/grants'

const unsupported = (): never => { throw new Error('bootstrap cannot use writer or anchor state') }
const key = (kind: string, id: string) => JSON.stringify([kind, id])

/** Construct only query repositories: no SessionStore, migrations, authority or publication. */
export async function bootstrapVisibility(database: SqlDatabase) {
  const executor = createBunStoreExecutor({ database })
  try {
  const q = executor.queries
  const grants = new GrantsRepository(q)
  const byResource = new Map<string, GrantRow[]>()
  // Caller has already established the read transaction; grants belong to its snapshot.
  for (const grant of await grants.loadWorldGrants()) {
    const k = key(grant.resourceKind, grant.resourceId)
    const rows = byResource.get(k) ?? []
    rows.push(grant)
    byResource.set(k, rows)
  }
  const worldIndex: WorldIndexReader = {
    grantsFor: (kind, id) => byResource.get(key(kind, id)) ?? [],
    issueForWorktree: unsupported, pendingCount: unsupported, user: unsupported, machine: unsupported,
  }
  const visibility = makeFeedVisibility({
    store: {
      issues: new IssuesRepository(q, unsupported),
      sessions: new SessionsRepository(q, unsupported),
      shipping: new ShippingRepository(q),
      automations: new AutomationsRepository(q),
      sync: new SyncRepository(q, syncServerTables),
    },
    worldIndex,
    audienceResourceIds: async () => [], audienceFor: async () => [],
    issueEventSubjects: () => [], authorizationRevision: async () => 0,
  })
  return { policy: new GrantEdgeVisibilityPolicy(visibility.state, new NoDelegationsGranted()), executor }
  } catch (error) { await executor.close(); throw error }
}
