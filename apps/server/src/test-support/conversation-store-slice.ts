/**
 * THE CONVERSATION STORE GROUP ON THE TEST RUN'S ENGINE [POD-6990, POD-6958 design 2.6,
 * 2.10].
 *
 * The group's repositories (the conversation index, the registry, the transcript mirror
 * and the transcript search index) composed as `store/conversations.ts` composes them,
 * over the two-engine slice's store: a migrated in-memory SQLite database on the store
 * shard, a clone of the run's Postgres template on the `server-store-pg` lane. Their tests
 * open this instead of a whole `SessionStore`, which cannot boot on Postgres until
 * POD-6994, so the same expectations run on both engines.
 *
 * Each repository is a {@link drainedRepository}: on Postgres a call runs in one
 * transaction that drops the change capture it wrote (see that module); on SQLite it is
 * the repository itself. Capture is proven by `sync/capture-pg.test.ts` and the write
 * census.
 */

import { randomUUID } from 'node:crypto'
import { asWorkspaceId } from '@podium/model'
import type { SQL } from 'drizzle-orm'
import { ConversationsRepository } from '../store/conversations'
import type { ConversationIndexRepository } from '../store/conversations/index'
import type { TranscriptMirrorRepository } from '../store/conversations/mirror'
import type { ConversationRegistryRepository } from '../store/conversations/registry'
import type { TranscriptIndexRepository } from '../store/conversations/transcript-index'
import { provisionWorkspaceFeed } from '../store/database'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import { attachLaneIntentAudit } from '../store/executor/lane-intent-audit'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import { type GlobalQueries, legacyWorkspaceQueries } from '../store/executor/sync-drizzle'
import { drainedRepository, drainedWrite } from './drained-repository'
import { openMigratedTestDatabase } from './migrated-database'
import { openSliceStore, PG_SLICE_TABLES, type SliceStore } from './pg-slice-tables'
import { clonePgTestDatabase, type TestStoreEngine, testStoreEngine } from './pg-test-database'
import { stageASeam } from './stage-a-seam'

/** The group's repositories on one store of the run's engine. */
export interface ConversationStoreSlice {
  readonly engine: TestStoreEngine
  readonly conversations: {
    readonly index: ConversationIndexRepository
    readonly registry: ConversationRegistryRepository
    readonly mirror: TranscriptMirrorRepository
    readonly transcriptIndex: TranscriptIndexRepository
    /** `ConversationsRepository.ensureFts`: search on (both indexes) or off. */
    ensureFts(enabled: boolean): Promise<void>
  }
  /**
   * Runs one raw write in the workspace's transaction. Written with drizzle's `sql`
   * template, so its values render as each engine's placeholders.
   */
  run(statement: SQL): Promise<void>
  /** Reads rows with one raw statement, as {@link run} writes. */
  all<T>(statement: SQL): Promise<T[]>
  close(): Promise<void>
}

/** The group's repositories over one workspace's slice, each drained on Postgres. */
function sliceOver(slice: SliceStore): ConversationStoreSlice {
  const { queries } = slice
  const composed = new ConversationsRepository(queries)
  const drained = <R extends object>(repository: R): R => drainedRepository(slice, repository)
  return {
    engine: slice.engine,
    conversations: {
      index: drained(composed.index),
      registry: drained(composed.registry),
      mirror: drained(composed.mirror),
      transcriptIndex: drained(composed.transcriptIndex),
      ensureFts: async (enabled) => await drainedWrite(slice, () => composed.ensureFts(enabled)),
    },
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

/** The group's repositories on a fresh store of the test run's engine (the self-hosted workspace). */
export async function openConversationStoreSlice(): Promise<ConversationStoreSlice> {
  return sliceOver(await openSliceStore())
}

/** One workspace's repositories in a database that several workspaces share. */
export interface WorkspaceConversationSlice extends ConversationStoreSlice {
  readonly workspaceId: string
}

/**
 * The group's repositories for each of `ids`, in that order, over ONE fresh database
 * of the run's engine, every workspace provisioned as `StoreDatabase.provisionWorkspace`
 * provisions it. Closing any of them closes the database for all.
 */
export async function openConversationStoreSlices<const Ids extends readonly [string, ...string[]]>(
  ids: Ids,
): Promise<{ readonly [K in keyof Ids]: WorkspaceConversationSlice }> {
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
    const slices = ids.map((id) => {
      const queries = legacyWorkspaceQueries(base, asWorkspaceId(id))
      const slice: SliceStore = { engine, queries, probeTarget, close }
      return { ...sliceOver(slice), workspaceId: id }
    })
    return slices as unknown as { readonly [K in keyof Ids]: WorkspaceConversationSlice }
  } catch (error) {
    await close()
    throw error
  }
}
