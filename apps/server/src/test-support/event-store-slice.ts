/**
 * THE EVENT AND WORKFLOW STORE GROUP ON THE TEST RUN'S ENGINE [POD-6988, POD-6958
 * design 2.10].
 *
 * The group's repositories (events, effects, workflows, automations, interactions,
 * superagent, observation checkpoints, transcript costs, maintenance, locks) built as
 * `store.ts` builds them, over the two-engine slice's store (`openSliceStore`): a
 * migrated in-memory SQLite database on the store shard, a clone of the run's
 * Postgres template on the `server-store-pg` lane. Their golden tests open this
 * instead of a whole `SessionStore`, which cannot boot on Postgres until POD-6994, so
 * the same expectations run on both engines.
 *
 * CHANGE CAPTURE IS NOT WHAT THESE TESTS CHECK. On SQLite the capture triggers are
 * installed by the whole store when it opens (`store.ts`), so a bare migrated database
 * captures nothing. On Postgres every write on a source table captures in its own
 * statement (`captureWrite`), and the baseline's deferred guard refuses to commit a
 * capture row nobody drained; the drain belongs to the change-log commit, which only a
 * whole store wires. So on Postgres this clone drops the guard and the capture rows
 * stay unread, as on SQLite there are none. Capture itself is proven by
 * `sync/capture-pg.test.ts`, its oracle and the write census.
 */

import { randomUUID } from 'node:crypto'
import { asWorkspaceId } from '@podium/model'
import { type SQL, sql } from 'drizzle-orm'
import { AutomationsRepository } from '../store/automations'
import { provisionWorkspaceFeed } from '../store/database'
import { EffectsRepository } from '../store/effects'
import { EventsRepository } from '../store/events'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import { attachLaneIntentAudit } from '../store/executor/lane-intent-audit'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import {
  type GlobalQueries,
  type LegacyWorkspaceQueries,
  legacyWorkspaceQueries,
} from '../store/executor/sync-drizzle'
import { InteractionsRepository } from '../store/interactions'
import { LocksRepository } from '../store/locks'
import { MaintenanceRepository } from '../store/maintenance'
import { ObservationCheckpointsRepository } from '../store/observation-checkpoints'
import { SessionsRepository } from '../store/sessions'
import { SuperagentRepository } from '../store/superagent'
import { TranscriptCostsRepository } from '../store/transcript-costs'
import { WorkflowsRepository } from '../store/workflows'
import { openMigratedTestDatabase } from './migrated-database'
import { openSliceStore, PG_SLICE_TABLES } from './pg-slice-tables'
import { clonePgTestDatabase, type TestStoreEngine, testStoreEngine } from './pg-test-database'
import { stageASeam } from './stage-a-seam'

/** The group's repositories on one store of the run's engine. */
export interface EventStoreSlice {
  readonly engine: TestStoreEngine
  readonly events: EventsRepository
  readonly effects: EffectsRepository
  readonly workflows: WorkflowsRepository
  readonly automations: AutomationsRepository
  readonly interactions: InteractionsRepository
  readonly superagent: SuperagentRepository
  readonly observationCheckpoints: ObservationCheckpointsRepository
  readonly transcriptCosts: TranscriptCostsRepository
  readonly maintenance: MaintenanceRepository
  readonly locks: LocksRepository
  /** What `countStatements` attaches to: the store's driver, on either engine. */
  readonly probeTarget: { readonly db: object }
  /**
   * Runs one raw write in the workspace's transaction. Written with drizzle's `sql`
   * template, so its values render as each engine's placeholders.
   */
  run(statement: SQL): Promise<void>
  /** Reads rows with one raw statement, as {@link run} writes. */
  all<T>(statement: SQL): Promise<T[]>
  close(): Promise<void>
}

/** The Postgres baseline's capture guard (POD-6981). */
const CAPTURE_GUARD = 'fk_sync_capture_undrained_sync_capture_guard_id_fk'

/** The group's repositories over one workspace's queries. */
function sliceOver(
  engine: TestStoreEngine,
  queries: LegacyWorkspaceQueries,
  probeTarget: { readonly db: object },
  close: () => Promise<void>,
): EventStoreSlice {
  const run = async (statement: SQL): Promise<void> => {
    await queries.createOrJoinTransaction(async () => {
      await queries.rootDb.run(statement)
    })
  }
  return {
    engine,
    events: new EventsRepository(queries),
    effects: new EffectsRepository(queries),
    workflows: new WorkflowsRepository(queries),
    automations: new AutomationsRepository(queries),
    interactions: new InteractionsRepository(queries),
    superagent: new SuperagentRepository(queries),
    observationCheckpoints: new ObservationCheckpointsRepository(queries),
    transcriptCosts: new TranscriptCostsRepository(queries),
    maintenance: new MaintenanceRepository(queries),
    locks: new LocksRepository(queries),
    probeTarget,
    run,
    all: async <T>(statement: SQL): Promise<T[]> =>
      (await queries.createOrJoinTransaction(
        async () => await queries.rootDb.all(statement),
      )) as T[],
    close,
  }
}

/** Drops the capture guard of a Postgres clone (see the module comment). */
async function dropCaptureGuard(queries: LegacyWorkspaceQueries): Promise<void> {
  await queries.createOrJoinTransaction(async () => {
    await queries.rootDb.run(sql.raw(`ALTER TABLE sync_capture DROP CONSTRAINT ${CAPTURE_GUARD}`))
  })
}

/** The group's repositories on a fresh store of the test run's engine. */
export async function openEventStoreSlice(): Promise<EventStoreSlice> {
  const slice = await openSliceStore()
  try {
    if (slice.engine === 'pg') await dropCaptureGuard(slice.queries)
  } catch (error) {
    await slice.close()
    throw error
  }
  return sliceOver(slice.engine, slice.queries, slice.probeTarget, async () => await slice.close())
}

/** One workspace's repositories in a database that several workspaces share. */
export interface WorkspaceEventSlice extends EventStoreSlice {
  readonly workspaceId: string
  /** The sessions repository, for the session rows the group's reads join. */
  readonly sessions: SessionsRepository
}

/**
 * The group's repositories for each of `ids`, in that order, over ONE fresh database
 * of the run's engine, every workspace provisioned as `StoreDatabase.provisionWorkspace`
 * provisions it. Closing any of them closes the database for all.
 */
export async function openEventStoreSlices<const Ids extends readonly [string, ...string[]]>(
  ids: Ids,
): Promise<{ readonly [K in keyof Ids]: WorkspaceEventSlice }> {
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
    const all = ids.map((id) => ({ id, queries: legacyWorkspaceQueries(base, asWorkspaceId(id)) }))
    // One database: dropping the guard through any workspace's queries drops it for all.
    const [first] = all
    if (engine === 'pg' && first !== undefined) await dropCaptureGuard(first.queries)
    const slices = all.map(({ id, queries }) => ({
      ...sliceOver(engine, queries, probeTarget, close),
      workspaceId: id,
      sessions: new SessionsRepository(queries),
    }))
    return slices as unknown as { readonly [K in keyof Ids]: WorkspaceEventSlice }
  } catch (error) {
    await close()
    throw error
  }
}
