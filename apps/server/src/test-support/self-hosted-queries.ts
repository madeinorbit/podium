/**
 * THE SELF-HOSTED WORKSPACE'S QUERIES OVER A BARE TEST DATABASE [POD-6959 design 2.4].
 *
 * A test that builds one scoped repository over its own migrated database (no
 * `SessionStore`) hands it these: the workspace's handle and its transaction runner, as
 * `store.ts` builds them for the self-hosted install. A test that opens its own
 * transactions around the repository's calls must use THIS runner: a workspace statement
 * inside a global transaction is refused.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import {
  type LegacyWorkspaceQueries,
  legacyWorkspaceQueries,
  syncQueriesOver,
} from '../store/executor/sync-drizzle'

export function selfHostedQueriesOver(db: SqlDatabase): LegacyWorkspaceQueries {
  return legacyWorkspaceQueries(syncQueriesOver(db), SELF_HOSTED_WORKSPACE_ID)
}
