/**
 * THE SYNC REPOSITORY ON THE STORE'S ENGINES [POD-6989, POD-6958 design 2.4, 2.10].
 *
 * The repository's oracle is its two package suites, the golden pins and the
 * per-workspace feed tests (`packages/sync/src/adapters/sqlite/test-support/sync-repository.suites.ts`).
 * This file runs both on the store's own database and query layer: SQLite on the store
 * lane, Postgres on `server-store-pg`, where every definition builds its Postgres form,
 * every write takes its workspace's `sync_feed` lock first, and the inbox writes are
 * change-capture forms. Beside them:
 *
 *  - statement pins for the repository's hot operations, the same count on both engines;
 *  - two writers in one workspace at once, which on Postgres are two executors (two
 *    connection pools, as two server processes would be) contending for the same
 *    feed row: the seqs never leave a gap a reader could step over, and never commit
 *    out of order.
 *
 * The store here is the repository's slice of one, built as `openSliceStore` builds
 * the two-engine slice's (`test-support/pg-slice-tables.ts`): a full `SessionStore`
 * cannot open on Postgres until POD-6994.
 */

import { randomUUID } from 'node:crypto'
import type { WorkspaceId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  describeSyncRepositoryGolden,
  describeTenantFeed,
  SUITE_WORKSPACE_ID,
  type SyncRepositoryFixture,
} from '../../../../packages/sync/src/adapters/sqlite/test-support/sync-repository.suites'
import type { ChangeLogWriteRow } from '../../../../packages/sync/src/authority/change-lifecycle'
import { syncServerTables } from '../migrations/sync-server-tables'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { PG_SLICE_TABLES } from '../test-support/pg-slice-tables'
import { clonePgTestDatabase, testStoreEngine } from '../test-support/pg-test-database'
import { stageASeam } from '../test-support/stage-a-seam'
import { expectConstantStatements } from '../test-support/statement-count'
import { provisionWorkspaceFeed } from './database'
import { CrossWorkspaceTransactionError } from './executor/context'
import type { QueryClient } from './executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from './executor/executor'
import { attachLaneIntentAudit } from './executor/lane-intent-audit'
import { createPgStoreDriver } from './executor/pg-driver'
import { pgQueryLayer } from './executor/pg-drizzle'
import { instrumentDriver, probeStatements, statementProbeHubFor } from './executor/statement-probe'
import { type GlobalQueries, legacyWorkspaceQueries } from './executor/sync-drizzle'

/** The suites' fixture over a store's engine, with what this file needs besides. */
interface StoreSyncFixture extends SyncRepositoryFixture {
  /** What `countStatements` attaches to: the store's driver, on either engine. */
  readonly probeTarget: { readonly db: object }
  /**
   * The workspace's queries of a second writer. On Postgres a second executor over the
   * same database, with its own pool and write slot; on SQLite the one connection's
   * executor, whose write queue is the serialisation.
   */
  secondWriter(workspaceId?: string): Promise<{
    readonly queries: ReturnType<typeof legacyWorkspaceQueries>
    close(): Promise<void>
  }>
}

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A Postgres executor over `url`, instrumented on `connection`'s probe hub. */
function pgExecutor(url: string, connection: object): RootStoreExecutor<QueryClient> {
  const hub = statementProbeHubFor(connection)
  attachLaneIntentAudit(hub)
  return createStoreExecutor<QueryClient>({
    driver: instrumentDriver(createPgStoreDriver({ url, poolSize: 2 }), hub),
    queryLayer: pgQueryLayer(PG_SLICE_TABLES),
    startOpen: true,
  })
}

/** A store of the run's engine, its workspaces provisioned as `StoreDatabase` provisions them. */
async function openStoreSyncFixture(): Promise<StoreSyncFixture> {
  const engine = testStoreEngine()
  let base: GlobalQueries
  let database: SqlDatabase | undefined
  let url: string | undefined
  let close: () => Promise<void>
  const connection = {}
  if (engine === 'sqlite') {
    database = openMigratedTestDatabase()
    base = stageASeam(database)
    const opened = database
    close = async () => opened.close()
  } else {
    url = (await clonePgTestDatabase()).url
    const executor = pgExecutor(url, connection)
    base = executor.queries
    close = async () => await executor.close()
  }
  const probeTarget = { db: database ?? connection }
  const queries = (workspaceId: string = SUITE_WORKSPACE_ID) =>
    legacyWorkspaceQueries(base, workspaceId as WorkspaceId)
  const provision = async (over: GlobalQueries, workspaceId: string) => {
    await over.createOrJoinTransaction(async () => {
      await provisionWorkspaceFeed(over.db).run({
        workspaceId,
        feedId: randomUUID(),
        epoch: randomUUID(),
        mintedAt: 0,
      })
    })
  }
  // A raw statement inside a write of the suite's workspace, on the transaction's
  // connection: the driver's own type handling, so an int8 reads as a number and a
  // `json` column as its text on both engines.
  const raw = async <T>(run: () => Promise<T>): Promise<T> =>
    await queries().createOrJoinTransaction(run)
  await provision(base, SUITE_WORKSPACE_ID)
  const repositoryOver = (over: ReturnType<typeof queries>, workspaceId: string) => {
    const repository = new SyncRepository(over, syncServerTables, workspaceId)
    // The store drains an inbox write's capture into the session record in the same
    // transaction (POD-6920); the fixture drains it and builds nothing, which is
    // what lets the write commit past the fail-closed guard on both engines.
    repository.sessionRecordWrite = async (write) =>
      await over.createOrJoinTransaction(async () => {
        const result = await write()
        await repository.drainCapture()
        return result
      })
    return repository
  }
  return {
    engine,
    provisioned: true,
    serverTables: syncServerTables,
    crossWorkspaceRefusal: CrossWorkspaceTransactionError,
    probeTarget,
    queries,
    async repository(workspaceId = SUITE_WORKSPACE_ID) {
      await provision(base, workspaceId)
      return repositoryOver(queries(workspaceId), workspaceId)
    },
    stored: async (text) =>
      database
        ? (database.prepare(text).all() as Record<string, unknown>[])
        : await raw(
            async () => (await base.rootDb.all(sql.raw(text))) as Record<string, unknown>[],
          ),
    async seed(text) {
      if (database) database.exec(text)
      else await raw(async () => await base.rootDb.run(sql.raw(text)))
    },
    async runInTransaction(text) {
      if (database) database.exec(text)
      else await base.rootDb.run(sql.raw(text))
    },
    async record(fn) {
      const seen: string[] = []
      const detach = probeStatements(probeTarget, (observation) => {
        seen.push(fold(observation.sql))
      })
      try {
        await fn()
      } finally {
        detach()
      }
      return seen
    },
    async secondWriter(workspaceId = SUITE_WORKSPACE_ID) {
      if (url === undefined) return { queries: queries(workspaceId), close: async () => {} }
      const executor = pgExecutor(url, {})
      return {
        queries: legacyWorkspaceQueries(executor.queries, workspaceId as WorkspaceId),
        close: async () => await executor.close(),
      }
    },
    close,
  }
}

describe('the golden pins, on the store engine', () => {
  describeSyncRepositoryGolden(openStoreSyncFixture)
})

describe('one feed per workspace, on the store engine', () => {
  describeTenantFeed(openStoreSyncFixture)
})

const changeRows = (n: number, prefix = 'i'): ChangeLogWriteRow[] =>
  Array.from({ length: n }, (_, i) => ({
    entity: 'issueProjection',
    entityId: `${prefix}${i}`,
    op: 'upsert',
    payload: '{}',
  }))

/**
 * THE HOT OPERATIONS RUN THE SAME STATEMENTS ON BOTH ENGINES [server-data rule 8,
 * design 2.10]. Each is one statement per definition on each engine: the Postgres
 * workspace lock rides in the transaction's pipelined begin and is not a statement of
 * the operation, and an inbox write's capture is part of its one statement (a trigger
 * on SQLite, the capture form on Postgres). Measured at 5 and 200 rows already in the
 * log, so a count that grows with the log fails.
 */
describe('statement counts, the same on both engines', () => {
  const pin = (
    name: string,
    run: (repository: SyncRepository) => Promise<unknown>,
    expected: number,
  ) =>
    it(name, async () => {
      await expectConstantStatements(
        {
          name,
          async setup(size) {
            const fixture = await openStoreSyncFixture()
            const repository = await fixture.repository()
            await repository.appendChanges(changeRows(size, 'seed-'), 1)
            return { fixture, repository }
          },
          target: ({ fixture }) => fixture.probeTarget,
          run: async ({ repository }) => await run(repository),
          teardown: async ({ fixture }) => await fixture.close(),
        },
        expected,
      )
    })

  // The reservation and one VALUES chunk.
  pin('appendChanges, one row', (repo) => repo.appendChanges(changeRows(1), 2), 2)
  // The reservation and two chunks of at most 100 rows.
  pin('appendChanges, 150 rows', (repo) => repo.appendChanges(changeRows(150), 2), 3)
  pin('changesSince, one page', (repo) => repo.changesSince(0, 500), 1)
  pin('readFeedState', (repo) => repo.readFeedState(), 1)
  // The age threshold read; the row threshold is the feed state read.
  pin('planChangePrune', (repo) => repo.planChangePrune({ keepRows: 1, maxAgeMs: 0, now: 2 }), 2)
  // The lock-taking zero reservation, one bounded delete and the floor.
  pin('pruneChangeBatch', (repo) => repo.pruneChangeBatch({ thresholdSeq: 3 }, 2), 3)
  // The insert (with its capture) and the drain.
  pin(
    'enqueueMessage, captured and drained',
    (repo) =>
      repo.enqueueMessage({
        id: randomUUID(),
        sessionId: 's1' as never,
        text: 'hello',
        queuedAt: 1,
      }),
    2,
  )
})

/**
 * TWO WRITERS IN ONE WORKSPACE [ADR 13, design 2.4 option C, acceptance of POD-6989].
 *
 * A seq is reserved by `UPDATE sync_feed SET head_seq = head_seq + n` under the
 * workspace's row lock, held until the append commits, so numbers are handed out in
 * commit order and a rolled-back reservation hands its numbers back. A sequence (or
 * a reservation that committed apart from its rows) would let seq 5 commit before
 * seq 4: a reader at cursor 4 would then step past 4 for good. On Postgres the two
 * writers are two executors, so the database lock is the only thing between them.
 */
describe('two concurrent writers in one workspace', () => {
  it('waits for the open writer and numbers after it', async () => {
    const fixture = await openStoreSyncFixture()
    const second = await fixture.secondWriter()
    try {
      const first = await fixture.repository()
      const other = new SyncRepository(second.queries, syncServerTables, SUITE_WORKSPACE_ID)
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let firstSeqs: number[] = []
      const holding = fixture.queries().createOrJoinTransaction(async () => {
        firstSeqs = await first.appendChanges(changeRows(3, 'a'), 1)
        await held
      })
      // Let the first writer take the lock before the second asks for it.
      while (firstSeqs.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
      let otherDone = false
      const waiting = other.appendChanges(changeRows(2, 'b'), 2).then((seqs) => {
        otherDone = true
        return seqs
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      // The second writer cannot reserve while the first holds the workspace.
      expect(otherDone).toBe(false)
      release()
      await holding
      expect(firstSeqs).toEqual([1, 2, 3])
      expect(await waiting).toEqual([4, 5])
      expect((await first.changesSince(0)).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5])
    } finally {
      await second.close()
      await fixture.close()
    }
  })

  it('never leaves a gap a reader steps over, and hands back a rolled-back reservation', async () => {
    const fixture = await openStoreSyncFixture()
    const second = await fixture.secondWriter()
    try {
      const writers = [
        await fixture.repository(),
        new SyncRepository(second.queries, syncServerTables, SUITE_WORKSPACE_ID),
      ]
      const reader = await fixture.repository()
      // A reader that follows the feed as a client's delta does: everything after its
      // cursor, the cursor moved to the newest seq it read.
      const seen: number[] = []
      let cursor = 0
      let writing = true
      const follow = async () => {
        for (const row of await reader.changesSince(cursor)) {
          seen.push(row.seq)
          cursor = row.seq
        }
      }
      const following = (async () => {
        while (writing) {
          await follow()
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      })()
      const returned: number[][] = []
      await Promise.all(
        writers.map(async (writer, w) => {
          for (let i = 0; i < 20; i++) {
            const n = 1 + ((i + w) % 3)
            if (i % 7 === 3) {
              // A reservation whose append fails: its numbers must not be lost.
              const broken = changeRows(n, `bad-${w}-${i}-`)
              broken[n - 1] = { ...(broken[n - 1] as ChangeLogWriteRow), entity: null as never }
              await expect(writer.appendChanges(broken, i)).rejects.toThrow()
              continue
            }
            returned.push(await writer.appendChanges(changeRows(n, `w${w}-${i}-`), i))
          }
        }),
      )
      writing = false
      await following
      await follow()
      const total = returned.reduce((sum, seqs) => sum + seqs.length, 0)
      const all = Array.from({ length: total }, (_, i) => i + 1)
      // Each append's numbers are one contiguous run, and together they are 1..total.
      for (const seqs of returned) {
        expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => (seqs[0] ?? 0) + i))
      }
      expect(returned.flat().sort((a, b) => a - b)).toEqual(all)
      // The reader saw every seq, once, in order: none committed behind its cursor.
      expect(seen).toEqual(all)
      expect(await reader.readFeedState()).toEqual({ headSeq: total, floorSeq: 1 })
    } finally {
      await second.close()
      await fixture.close()
    }
  })
})
