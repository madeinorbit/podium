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

import { type SQL, sql } from 'drizzle-orm'
import { AutomationsRepository } from '../store/automations'
import { EffectsRepository } from '../store/effects'
import { EventsRepository } from '../store/events'
import { InteractionsRepository } from '../store/interactions'
import { LocksRepository } from '../store/locks'
import { MaintenanceRepository } from '../store/maintenance'
import { ObservationCheckpointsRepository } from '../store/observation-checkpoints'
import { SuperagentRepository } from '../store/superagent'
import { TranscriptCostsRepository } from '../store/transcript-costs'
import { WorkflowsRepository } from '../store/workflows'
import { openSliceStore } from './pg-slice-tables'
import type { TestStoreEngine } from './pg-test-database'

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

/** The group's repositories on a fresh store of the test run's engine. */
export async function openEventStoreSlice(): Promise<EventStoreSlice> {
  const slice = await openSliceStore()
  const { queries } = slice
  const run = async (statement: SQL): Promise<void> => {
    await queries.createOrJoinTransaction(async () => {
      await queries.rootDb.run(statement)
    })
  }
  try {
    if (slice.engine === 'pg') {
      await run(sql.raw(`ALTER TABLE sync_capture DROP CONSTRAINT ${CAPTURE_GUARD}`))
    }
  } catch (error) {
    await slice.close()
    throw error
  }
  return {
    engine: slice.engine,
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
    probeTarget: slice.probeTarget,
    run,
    all: async <T>(statement: SQL): Promise<T[]> =>
      (await queries.createOrJoinTransaction(
        async () => await queries.rootDb.all(statement),
      )) as T[],
    close: async () => await slice.close(),
  }
}
