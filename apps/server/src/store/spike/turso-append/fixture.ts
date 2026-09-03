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
import { RESET_DDL, SCHEMA_DDL } from './schema'
import type { QueryDb } from './sync-append'

export interface Slice {
  readonly counted: CountedClient
  readonly driver: LibsqlSpikeDriver
  readonly db: QueryDb
  /** Open a session on the write lane and hand it to `body`, closing it after. */
  withSession<T>(body: (session: DriverSession) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/**
 * Build the slice over one backend.
 *
 * `reset` drops the tables first. It is the default because the hosted spike
 * database is REUSED between runs — a proof about contiguous sequence numbers
 * starting from 1 would otherwise pass or fail depending on what the previous
 * run left behind, which is the kind of test that is green until it matters.
 */
export async function openSlice(
  config: BackendConfig,
  options: { reset?: boolean } = {},
): Promise<Slice> {
  const counted = createCountedClient(config)
  const driver = new LibsqlSpikeDriver(counted)
  const db = drizzle({ client: counted.client })

  if (options.reset !== false) {
    for (const ddl of RESET_DDL) await counted.client.execute(ddl)
  }
  for (const ddl of SCHEMA_DDL) await counted.client.execute(ddl)
  counted.roundTrips.reset()

  return {
    counted,
    driver,
    db,
    async withSession(body) {
      const session = await driver.open('write')
      try {
        return await body(session)
      } finally {
        await session.close()
      }
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
