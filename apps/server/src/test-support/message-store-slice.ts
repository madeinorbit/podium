/**
 * THE MESSAGE AND MESSAGING STORE GROUP ON THE TEST RUN'S ENGINE [POD-6985, POD-6958
 * design 2.10].
 *
 * The group's repositories (messages, messaging topics, messaging session attachments,
 * Telegram bindings, notification facts) built as `store.ts` builds them, over the
 * two-engine slice's store (`openSliceStore`): a migrated in-memory SQLite database on
 * the store shard, a clone of the run's Postgres template on the `server-store-pg`
 * lane. Their tests open this instead of a whole `SessionStore`, which cannot boot on
 * Postgres until POD-6994, so the same expectations run on both engines.
 *
 * CHANGE CAPTURE IS NOT WHAT THESE TESTS CHECK. On Postgres every write on a source
 * table captures in its own statement, and the baseline's guard refuses to commit a
 * capture row nobody drained; only a whole store's commit layer drains. So each
 * repository here is a {@link drainedRepository} (and each raw write a
 * {@link drainedWrite}): on Postgres a call runs in one transaction that drops what it
 * captured, on SQLite it is the repository itself. Capture itself is proven by
 * `sync/capture-pg.test.ts`, its oracle and the write census.
 */

import { randomUUID } from 'node:crypto'
import { asWorkspaceId } from '@podium/model'
import type { SQL } from 'drizzle-orm'
import { provisionWorkspaceFeed } from '../store/database'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import { attachLaneIntentAudit } from '../store/executor/lane-intent-audit'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import { type GlobalQueries, legacyWorkspaceQueries } from '../store/executor/sync-drizzle'
import { MessagesRepository } from '../store/messages'
import { MessagingSessionAttachmentsRepository } from '../store/messaging-session-attachments'
import { MessagingTopicsRepository } from '../store/messaging-topics'
import { NotificationFactsRepository } from '../store/notification-facts'
import { SessionsRepository } from '../store/sessions'
import { TelegramBindingsRepository } from '../store/telegram-bindings'
import { drainedRepository, drainedWrite } from './drained-repository'
import { openMigratedTestDatabase } from './migrated-database'
import { openSliceStore, PG_SLICE_TABLES, type SliceStore } from './pg-slice-tables'
import { clonePgTestDatabase, type TestStoreEngine, testStoreEngine } from './pg-test-database'
import { stageASeam } from './stage-a-seam'

/** The group's repositories on one store of the run's engine. */
export interface MessageStoreSlice {
  readonly engine: TestStoreEngine
  readonly messages: MessagesRepository
  readonly messagingTopics: MessagingTopicsRepository
  readonly messagingSessionAttachments: MessagingSessionAttachmentsRepository
  readonly telegramBindings: TelegramBindingsRepository
  readonly notificationFacts: NotificationFactsRepository
  /** The sessions repository, for the session rows the group's reads join. */
  readonly sessions: SessionsRepository
  /**
   * The same repositories NOT drained, for a statement pin of a read. A read
   * captures nothing, so it needs no drain, and on Postgres the drain's own two
   * statements would be counted with the read's.
   */
  readonly undrained: {
    readonly messages: MessagesRepository
    readonly messagingSessionAttachments: MessagingSessionAttachmentsRepository
  }
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

/** The group's repositories over one workspace's slice, each drained on Postgres. */
function sliceOver(slice: SliceStore): MessageStoreSlice {
  const { queries } = slice
  const drained = <R extends object>(repository: R): R => drainedRepository(slice, repository)
  return {
    engine: slice.engine,
    messages: drained(new MessagesRepository(queries)),
    messagingTopics: drained(new MessagingTopicsRepository(queries)),
    messagingSessionAttachments: drained(new MessagingSessionAttachmentsRepository(queries)),
    telegramBindings: drained(new TelegramBindingsRepository(queries)),
    notificationFacts: drained(new NotificationFactsRepository(queries)),
    sessions: drained(new SessionsRepository(queries)),
    undrained: {
      messages: new MessagesRepository(queries),
      messagingSessionAttachments: new MessagingSessionAttachmentsRepository(queries),
    },
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

/** The group's repositories on a fresh store of the test run's engine. */
export async function openMessageStoreSlice(): Promise<MessageStoreSlice> {
  return sliceOver(await openSliceStore())
}

/** One workspace's repositories in a database that several workspaces share. */
export interface WorkspaceMessageSlice extends MessageStoreSlice {
  readonly workspaceId: string
}

/**
 * The group's repositories for each of `ids`, in that order, over ONE fresh database
 * of the run's engine, every workspace provisioned as `StoreDatabase.provisionWorkspace`
 * provisions it. Closing any of them closes the database for all.
 */
export async function openMessageStoreSlices<const Ids extends readonly [string, ...string[]]>(
  ids: Ids,
): Promise<{ readonly [K in keyof Ids]: WorkspaceMessageSlice }> {
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
    return slices as unknown as { readonly [K in keyof Ids]: WorkspaceMessageSlice }
  } catch (error) {
    await close()
    throw error
  }
}
