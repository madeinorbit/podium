/**
 * One appended-to database, on whichever backend the caller names [POD-3250].
 *
 * Every proof needs the same three things — a counted client, a drizzle instance
 * built over it, and the slice's tables freshly created — and needs them
 * identically on the local `sqld` and on the hosted spike database, because a
 * result that only holds on one of the two is not a result. Assembling that once
 * here is what makes the tests read as the questions they are asking instead of
 * as setup.
 */

import { drizzle } from 'drizzle-orm/libsql/web'
import type { DriverSession } from '../../executor/driver'
import { type BackendConfig, type CountedClient, createCountedClient } from './client'
import { LibsqlSpikeDriver } from './libsql-driver'
import { runTablePrefix } from './namespace'
import { resetDdl, schemaDdl, type SpikeTables, spikeTables } from './schema'
import type { QueryDb } from './sync-append'

export interface Slice {
  readonly counted: CountedClient
  readonly driver: LibsqlSpikeDriver
  readonly db: QueryDb
  /**
   * This run's tables. Passed to every query-building function rather than
   * imported by it, so the namespace can never be assumed [POD-3358].
   */
  readonly tables: SpikeTables
  /** The run's table-name prefix — needed by the slice's few raw statements. */
  readonly prefix: string
  /** Open a session on the write lane and hand it to `body`, closing it after. */
  withSession<T>(body: (session: DriverSession) => Promise<T>): Promise<T>
  /**
   * Drop this run's tables.
   *
   * A namespace that is never collected is a slow version of the problem it
   * solves: the hosted database is shared and permanent, so a prefix per run
   * with no cleanup grows a new set of four tables every time anyone runs the
   * proof [POD-3358]. Callers that own a whole run drop theirs on the way out.
   */
  dropTables(): Promise<void>
  close(): Promise<void>
}

/**
 * Build the slice over one backend, in this run's namespace.
 *
 * `reset` drops the tables first. It is the default because the spike database
 * is REUSED between runs — a proof about contiguous sequence numbers starting
 * from 1 would otherwise pass or fail depending on what the previous run left
 * behind, which is the kind of test that is green until it matters.
 *
 * THAT DROP IS WHY THE PREFIX EXISTS [POD-3358]. On the hosted database every
 * run used to reset the same four table names, so a second run starting while a
 * first was mid-proof deleted its log underneath it — and the first run reported
 * the result it computed from the wreckage rather than failing. The reset is
 * still here and still unconditional; the prefix is what makes it reach only the
 * caller's own tables.
 *
 * `prefix` defaults to the process-wide run namespace, which is what every
 * caller wants: slices opened within one run must SHARE tables, because proofs 3
 * and 7 are specifically about two clients writing to one log. Only a separate
 * run gets a separate namespace. It is a parameter at all so the concurrency
 * check can point two slices at a namespace it names itself.
 */
export async function openSlice(
  config: BackendConfig,
  options: { reset?: boolean; prefix?: string } = {},
): Promise<Slice> {
  const prefix = options.prefix ?? runTablePrefix()
  const tables = spikeTables(prefix)
  const counted = createCountedClient(config, prefix)
  const driver = new LibsqlSpikeDriver(counted)
  const db = drizzle({ client: counted.client })

  if (options.reset !== false) {
    for (const ddl of resetDdl(prefix)) await counted.client.execute(ddl)
  }
  for (const ddl of schemaDdl(prefix)) await counted.client.execute(ddl)
  counted.roundTrips.reset()

  return {
    counted,
    driver,
    db,
    tables,
    prefix,
    async withSession(body) {
      const session = await driver.open('write')
      try {
        return await body(session)
      } finally {
        await session.close()
      }
    },
    dropTables: async () => {
      for (const ddl of resetDdl(prefix)) await counted.client.execute(ddl)
    },
    close: () => driver.close(),
  }
}

/** `n` upsert rows for one entity family, distinguishable by their ids. */
export function upsertRows(
  n: number,
  prefix = 'e',
): { entity: string; entityId: string; op: 'upsert'; payload: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    entity: 'issue',
    entityId: `${prefix}${i}`,
    op: 'upsert' as const,
    payload: JSON.stringify({ i }),
  }))
}
