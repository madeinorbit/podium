/**
 * THE DATABASE THE JANITOR SERVES, ON THE STORE'S ENGINE [POD-6993, POD-6958 design 2.9].
 *
 * The janitor (`packages/janitor`) observes durable facts through its `JanitorReads` port
 * and holds no SQL. This opens that port on the store at `location`: a SQLite file path or
 * a Postgres URL, which names the engine (`storeEngineFor`). Every read runs inside a READ
 * SESSION of the store's own engine, the one the sync worker reads in
 * (`sync-worker/read-session.ts`): on SQLite its own read-only WAL connection in a
 * deferred `BEGIN`, on Postgres one pooled connection in `REPEATABLE READ READ ONLY`.
 * The reads themselves are the store's query definitions (`store/janitor-reads.ts`), so
 * the same source builds each engine's SQL.
 *
 * ONE SESSION PER SCAN. A scan (one job's reads: the expiry walk, a prune plan, an archive
 * page walk) opens a session, reads in its one snapshot, and closes it before the janitor
 * sends the commands its observations become. A session held across a tick would hold the
 * snapshot across those commands: SQLite could not checkpoint past it and Postgres's vacuum
 * would keep the row versions it sees, while the commands' own writes would be invisible
 * to the next job's reads.
 */

import type { JanitorDatabase, JanitorReads, JanitorWorkspace } from '@podium/janitor'
import type { WorkspaceId } from '@podium/model'
import { fleetDb, workspaceQueries } from './store/executor/sync-drizzle'
import { JanitorReadsRepository, workspacesWithFeed } from './store/janitor-reads'
import { openWorkerReadSession, type WorkerReadSession } from './sync-worker/read-session'

/** Run `fn` in one read session of the store at `location`, and end the session. */
async function inSession<T>(
  location: string,
  fn: (session: WorkerReadSession) => Promise<T>,
): Promise<T> {
  const session = await openWorkerReadSession(location)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

/** The janitor's database on the store at `location`. Opening connects to nothing. */
export function openJanitorDatabase(location: string): JanitorDatabase {
  const workspaceAt = (id: WorkspaceId): JanitorWorkspace => ({
    id,
    scan: async <T>(fn: (reads: JanitorReads) => Promise<T>): Promise<T> =>
      await inSession(location, async (session) => {
        const reads = new JanitorReadsRepository(workspaceQueries(session.executor.queries, id))
        return await fn(reads)
      }),
  })
  return {
    workspacesWithFeed: async () =>
      await inSession(location, async (session) => {
        const ids = await workspacesWithFeed(fleetDb(session.executor.queries))
        return ids.map(workspaceAt)
      }),
    // Every session ends with its scan: nothing is left open between scans.
    close: async () => {},
  }
}
