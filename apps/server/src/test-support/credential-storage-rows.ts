import type { SessionStore } from '../store'
import { inWorkspace, legacyWorkspaceQueries, preparedFamily } from '../store/executor/sync-drizzle'

type StorageTable = 'vaultKey' | 'credentials' | 'credentialSecrets' | 'settingsAuditEvents'
const rows = preparedFamily((db, tables, table: StorageTable) =>
  db.select().from(tables[table]).where(inWorkspace(tables[table])).prepare(),
)

/** Inspect the stored bytes below the vault on either engine, in this
 * fixture's workspace. Tests prove a secret canary is absent from these rows. */
export async function credentialStorageRows(store: SessionStore, table: StorageTable) {
  const queries = legacyWorkspaceQueries(store.database.queries, store.workspaceId)
  return await rows(queries.db, table).all()
}
