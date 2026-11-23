/**
 * THE SHIPPING REPOSITORY ON THE TEST RUN'S ENGINE [POD-6986, POD-6958 design 2.10].
 *
 * The shipping tests read and write ship orders, attempts, steps, holds, trains and
 * receipts through `ShippingRepository`, and the issues those orders ship through
 * `IssuesRepository`. A full `SessionStore` cannot open on Postgres until POD-6994, so
 * this builds the two (and the repository registry the issues resolve through) the way
 * `store.ts` builds them, over the slice store of the run's engine (`openSliceStore`): a
 * migrated in-memory SQLite database on the store lane, a clone of the run's Postgres
 * template on `server-store-pg`.
 *
 * CHANGE CAPTURE IS NOT WHAT THESE TESTS CHECK. Every write on a source table captures on
 * Postgres in its own statement, and the baseline's guard refuses to commit a capture
 * row nobody drained, so each repository here is a {@link drainedRepository} (and each
 * raw write a {@link drainedWrite}): on Postgres a call runs in one transaction that drops
 * what it captured, on SQLite it is the repository itself.
 */

import { randomUUID } from 'node:crypto'
import { asUserId, asWorkspaceId, primeFirstAdminMember } from '@podium/model'
import type { SQL } from 'drizzle-orm'
import { provisionWorkspaceFeed } from '../store/database'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import { attachLaneIntentAudit } from '../store/executor/lane-intent-audit'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import { type GlobalQueries, legacyWorkspaceQueries } from '../store/executor/sync-drizzle'
import { IssuesRepository } from '../store/issues'
import { ReposRepository } from '../store/repos'
import { ShippingRepository } from '../store/shipping'
import { TableWrites } from '../store/table-writes'
import { drainedRepository, drainedWrite } from './drained-repository'
import { openMigratedTestDatabase } from './migrated-database'
import { openSliceStore, PG_SLICE_TABLES, type SliceStore } from './pg-slice-tables'
import { clonePgTestDatabase, type TestStoreEngine, testStoreEngine } from './pg-test-database'
import { stageASeam } from './stage-a-seam'

/** The shipping tests' repositories on one store of the run's engine. */
export interface ShippingStoreSlice {
  readonly engine: TestStoreEngine
  readonly shipping: ShippingRepository
  readonly issues: IssuesRepository
  readonly repos: ReposRepository
  /**
   * The shipping repository NOT drained, for a statement pin of a write that captures
   * nothing: on Postgres the drain's own statements would be counted with the write's.
   */
  readonly undrainedShipping: ShippingRepository
  /** What `countStatements` attaches to: the store's driver, on either engine. */
  readonly probeTarget: { readonly db: object }
  /**
   * Runs one raw write in the workspace's transaction, drained. Written with drizzle's
   * `sql` template, so its values render as each engine's placeholders.
   */
  run(statement: SQL): Promise<void>
  /** Reads rows with one raw statement, as {@link run} writes. */
  all<T>(statement: SQL): Promise<T[]>
  close(): Promise<void>
}

/** The repositories over one workspace's slice, each drained on Postgres. */
function sliceOver(slice: SliceStore): ShippingStoreSlice {
  const { queries } = slice
  let issues: IssuesRepository | undefined
  const repos = new ReposRepository(
    queries,
    async (repoId, repoPath) => await issues?.assignRepoIdToIssuesUnder(repoId, repoPath),
    new TableWrites(),
  )
  issues = new IssuesRepository(
    queries,
    async (repoPath, machineId) => await repos.resolveIssueRepoId(repoPath, machineId),
  )
  return {
    engine: slice.engine,
    shipping: drainedRepository(slice, new ShippingRepository(queries)),
    issues: drainedRepository(slice, issues),
    repos: drainedRepository(slice, repos),
    undrainedShipping: new ShippingRepository(queries),
    probeTarget: slice.probeTarget,
    run: async (statement: SQL): Promise<void> => {
      await drainedWrite(slice, async () => {
        await queries.createOrJoinTransaction(async () => {
          await queries.rootDb.run(statement)
        })
      })
    },
    all: async <T>(statement: SQL): Promise<T[]> =>
      (await queries.createOrJoinTransaction(
        async () => await queries.rootDb.all(statement),
      )) as T[],
    close: async () => await slice.close(),
  }
}

/**
 * The fixtures name the first admin as an issue's owner. On SQLite the pre-migrated
 * image primes it; the Postgres template seeds no member, so a fixed one stands in.
 */
function primeFirstAdmin(engine: TestStoreEngine): void {
  if (engine === 'pg') primeFirstAdminMember(asUserId('user:pg-first-admin'))
}

/** For a test whose fixtures name the first admin before it opens a slice. */
export function primeShippingFixtureAdmin(): void {
  primeFirstAdmin(testStoreEngine())
}

/** The shipping repositories on a fresh store of the test run's engine. */
export async function openShippingStoreSlice(): Promise<ShippingStoreSlice> {
  const slice = await openSliceStore()
  primeFirstAdmin(slice.engine)
  return sliceOver(slice)
}

/** One workspace's repositories in a database that several workspaces share. */
export interface WorkspaceShippingSlice extends ShippingStoreSlice {
  readonly workspaceId: string
}

/**
 * The repositories for each of `ids`, in that order, over ONE fresh database of the
 * run's engine, every workspace provisioned as `StoreDatabase.provisionWorkspace`
 * provisions it. Closing any of them closes the database for all.
 */
export async function openShippingStoreSlices<const Ids extends readonly [string, ...string[]]>(
  ids: Ids,
): Promise<{ readonly [K in keyof Ids]: WorkspaceShippingSlice }> {
  let engine: TestStoreEngine
  let base: GlobalQueries
  let probeTarget: { readonly db: object }
  let close: () => Promise<void>
  if (testStoreEngine() !== 'pg') {
    const database = openMigratedTestDatabase()
    engine = 'sqlite'
    base = stageASeam(database)
    probeTarget = { db: database }
    close = async () => database.close()
  } else {
    const { url } = await clonePgTestDatabase()
    const connection = {}
    const hub = statementProbeHubFor(connection)
    attachLaneIntentAudit(hub)
    const executor: RootStoreExecutor<QueryClient> = createStoreExecutor<QueryClient>({
      driver: instrumentDriver(createPgStoreDriver({ url, poolSize: 2 }), hub),
      queryLayer: pgQueryLayer(PG_SLICE_TABLES),
      startOpen: true,
    })
    engine = 'pg'
    base = executor.queries
    probeTarget = { db: connection }
    close = async () => await executor.close()
  }
  primeFirstAdmin(engine)
  try {
    await base.createOrJoinTransaction(async () => {
      for (const id of ids) {
        await provisionWorkspaceFeed(base.db).run({
          workspaceId: id,
          feedId: randomUUID(),
          epoch: randomUUID(),
          mintedAt: Date.now(),
        })
      }
    })
    const slices = ids.map((id) => {
      const queries = legacyWorkspaceQueries(base, asWorkspaceId(id))
      const slice: SliceStore = { engine, queries, probeTarget, close }
      return { ...sliceOver(slice), workspaceId: id }
    })
    return slices as unknown as { readonly [K in keyof Ids]: WorkspaceShippingSlice }
  } catch (error) {
    await close()
    throw error
  }
}
