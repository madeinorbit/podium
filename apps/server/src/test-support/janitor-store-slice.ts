/**
 * THE JANITOR'S READS ON THE RUN'S ENGINE [POD-6993].
 *
 * One store of the test run's engine (`PODIUM_TEST_STORE_ENGINE`), one or more
 * workspaces in it, and for each the janitor's reads (`store/janitor-reads.ts`) plus
 * seeders for the facts they observe. Seeds are written through the store's own tables
 * (`seedSliceRow`), so each engine gets its own SQL and its native column types, and on
 * Postgres their change capture is dropped as `drainedWrite` drops it.
 *
 * {@link JanitorStore.location} hands the janitor's database opener
 * (`janitor-database.ts`) a location it can open the way production does: the Postgres
 * clone's URL, or on SQLite a file copy of the in-memory database taken at that moment
 * (`VACUUM INTO`), since a read session opens its own read-only connection by path.
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asWorkspaceId, type WorkspaceId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { and, eq, inArray } from 'drizzle-orm'
import { provisionWorkspaceFeed } from '../store/database'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import { attachLaneIntentAudit } from '../store/executor/lane-intent-audit'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { instrumentDriver, statementProbeHubFor } from '../store/executor/statement-probe'
import { type GlobalQueries, legacyWorkspaceQueries } from '../store/executor/sync-drizzle'
import { JanitorReadsRepository } from '../store/janitor-reads'
import { seedSliceRow } from './drained-repository'
import { openMigratedTestDatabase } from './migrated-database'
import { PG_SLICE_TABLES, type SliceStore } from './pg-slice-tables'
import { clonePgTestDatabase, type TestStoreEngine, testStoreEngine } from './pg-test-database'
import { stageASeam } from './stage-a-seam'

const T0 = '2026-01-01T00:00:00.000Z'

/** One workspace's janitor reads and its seeders. */
export interface JanitorSlice {
  readonly engine: TestStoreEngine
  readonly workspaceId: WorkspaceId
  readonly slice: SliceStore
  readonly reads: JanitorReadsRepository
  readonly seed: JanitorSeeds
}

/** The store the slices share. */
export interface JanitorStore {
  readonly engine: TestStoreEngine
  /** The store's global queries (the fleet handle is made from them). */
  readonly base: GlobalQueries
  /** A location the janitor's database opener opens: the store as it is now. */
  location(): Promise<string>
  close(): Promise<void>
}

export interface JanitorSeeds {
  message(row: {
    id: string
    lifecycle: 'wait' | 'wake'
    createdAt: string
    expiresAt?: string | null
    deliveryStatus?: 'stored' | 'dispatched' | 'expired'
  }): Promise<void>
  /** An event at `ts`; returns its id. */
  event(ts: string): Promise<number>
  /** Deletes these events, leaving their ids missing from the log. */
  pruneEvents(ids: readonly number[]): Promise<void>
  /** Sets the workspace feed's bounds. */
  feed(bounds: { headSeq: number; floorSeq: number }): Promise<void>
  change(row: { seq: number; eventTime: number }): Promise<void>
  command(row: { runKey: string; appliedAt: string }): Promise<void>
  /** A mutation receipt applied at `appliedAt` (epoch ms). */
  receipt(row: { mutationId: string; appliedAt: number }): Promise<void>
  /** A session's queued input, queued at `queuedAt` (epoch ms). */
  queued(row: {
    id: string
    sessionId: string
    queuedAt: number
    queueOrder?: number
  }): Promise<void>
  user(row: {
    id: string
    role?: 'admin' | 'member'
    createdAt?: string
    disabledAt?: string | null
  }): Promise<void>
  session(row: {
    id: string
    ownerUserId: string
    issueId?: string | null
    stoppedAt?: string | null
    archived?: boolean
    status?: string
    cwd?: string
  }): Promise<void>
  sessionRead(row: { sessionId: string; userId: string; readAt: string | null }): Promise<void>
  issue(row: {
    id: string
    ownerUserId?: string
    seq: number
    parentId?: string | null
    stage?: 'done' | 'in_progress' | 'backlog'
    closedReason?: string | null
    closedAt?: string | null
    worktreePath?: string | null
    deletedAt?: string | null
    archived?: boolean
  }): Promise<void>
  issueRead(row: { issueId: string; userId: string; readAt: string | null }): Promise<void>
  automation(row: {
    id: string
    enabled?: boolean
    nextRunAt: string | null
    scheduleKind?: 'cron' | 'once'
  }): Promise<void>
  steward(row: { key: string; value: string }): Promise<void>
  machine(row: { id: string; lastSeenAt: string }): Promise<void>
}

function seedsOf(slice: SliceStore, workspaceId: WorkspaceId): JanitorSeeds {
  const seed = (build: Parameters<typeof seedSliceRow>[1]) => seedSliceRow(slice, build)
  return {
    message: (row) =>
      seed((db, t) =>
        db
          .insert(t.messages)
          .values({
            workspaceId,
            id: row.id,
            threadId: `thr_${row.id}` as never,
            fromKind: 'system',
            toKind: 'operator',
            body: row.id,
            lifecycle: row.lifecycle,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt ?? null,
            deliveryStatus: row.deliveryStatus ?? 'stored',
          })
          .prepare(),
      ),
    event: async (ts) => {
      let id = 0
      await seed((db, t) => ({
        run: async () => {
          const [row] = await db
            .insert(t.podiumEvents)
            .values({ workspaceId, ts, kind: 'test', subject: 'janitor' })
            .returning({ id: t.podiumEvents.id })
            .prepare()
            .all()
          id = row?.id ?? 0
        },
      }))
      return id
    },
    pruneEvents: (ids) =>
      seed((db, t) =>
        db
          .delete(t.podiumEvents)
          .where(
            and(eq(t.podiumEvents.workspaceId, workspaceId), inArray(t.podiumEvents.id, [...ids])),
          )
          .prepare(),
      ),
    feed: (bounds) =>
      seed((db, t) =>
        db.update(t.syncFeed).set(bounds).where(eq(t.syncFeed.workspaceId, workspaceId)).prepare(),
      ),
    change: (row) =>
      seed((db, t) =>
        db
          .insert(t.changes)
          .values({
            workspaceId,
            seq: row.seq,
            entity: 'issue',
            entityId: `iss_${row.seq}`,
            op: 'upsert',
            eventTime: row.eventTime,
          } as never)
          .prepare(),
      ),
    command: (row) =>
      seed((db, t) =>
        db
          .insert(t.maintenanceCommands)
          .values({
            workspaceId,
            jobKind: 'test',
            runKey: row.runKey,
            fencingToken: 1,
            resultJson: '{}',
            appliedAt: row.appliedAt,
          })
          .prepare(),
      ),
    receipt: (row) =>
      seed((db, t) =>
        db
          .insert(t.appliedMutations)
          .values({
            workspaceId,
            mutationId: row.mutationId as never,
            proc: 'p',
            result: '"r"',
            appliedAt: row.appliedAt,
          })
          .prepare(),
      ),
    queued: (row) =>
      seed((db, t) =>
        db
          .insert(t.queuedMessages)
          .values({
            workspaceId,
            id: row.id,
            sessionId: row.sessionId as never,
            text: row.id,
            queuedAt: row.queuedAt,
            queueOrder: row.queueOrder ?? 1,
          } as never)
          .prepare(),
      ),
    user: (row) =>
      seed((db, t) =>
        db
          .insert(t.users)
          .values({
            workspaceId,
            id: row.id as never,
            displayName: row.id,
            role: row.role ?? 'admin',
            createdAt: row.createdAt ?? T0,
            disabledAt: row.disabledAt ?? null,
          })
          .prepare(),
      ),
    session: (row) =>
      seed((db, t) =>
        db
          .insert(t.sessions)
          .values({
            workspaceId,
            id: row.id as never,
            ownerUserId: row.ownerUserId as never,
            agentKind: 'claude-code',
            cwd: row.cwd ?? '/r',
            title: row.id,
            originKind: 'user',
            status: row.status ?? 'exited',
            durableLabel: row.id,
            createdAt: T0,
            lastActiveAt: T0,
            machineId: 'local' as never,
            issueId: (row.issueId ?? null) as never,
            stoppedAt: row.stoppedAt ?? null,
            archived: row.archived ?? false,
          } as never)
          .prepare(),
      ),
    sessionRead: (row) =>
      seed((db, t) =>
        db
          .insert(t.sessionUserState)
          .values({
            workspaceId,
            sessionId: row.sessionId as never,
            userId: row.userId as never,
            readAt: row.readAt,
          } as never)
          .prepare(),
      ),
    issue: (row) =>
      seed((db, t) =>
        db
          .insert(t.issues)
          .values({
            workspaceId,
            id: row.id as never,
            ownerUserId: (row.ownerUserId ?? 'mem_owner') as never,
            createdByActor: 'user:mem_owner',
            repoPath: '/r',
            seq: row.seq,
            title: row.id,
            stage: row.stage ?? 'done',
            defaultAgent: 'claude-code',
            createdAt: T0,
            updatedAt: T0,
            parentId: (row.parentId ?? null) as never,
            closedReason: row.closedReason ?? null,
            closedAt: row.closedAt ?? null,
            worktreePath: row.worktreePath ?? null,
            deletedAt: row.deletedAt ?? null,
            archived: row.archived ?? false,
          } as never)
          .prepare(),
      ),
    issueRead: (row) =>
      seed((db, t) =>
        db
          .insert(t.issueUserState)
          .values({
            workspaceId,
            issueId: row.issueId as never,
            userId: row.userId as never,
            readAt: row.readAt,
          } as never)
          .prepare(),
      ),
    automation: (row) =>
      seed((db, t) =>
        db
          .insert(t.automations)
          .values({
            workspaceId,
            id: row.id as never,
            ownerUserId: 'mem_owner' as never,
            createdByActor: 'user:mem_owner',
            createdByOnBehalfOf: 'mem_owner' as never,
            name: row.id,
            cron: '0 * * * *',
            agentKind: 'claude-code',
            prompt: 'p',
            createdAt: T0,
            enabled: row.enabled ?? true,
            nextRunAt: row.nextRunAt,
            scheduleKind: row.scheduleKind ?? 'cron',
          } as never)
          .prepare(),
      ),
    steward: (row) =>
      seed((db, t) =>
        db.insert(t.stewardState).values({ workspaceId, key: row.key, value: row.value }).prepare(),
      ),
    machine: (row) =>
      seed((db, t) =>
        db
          .insert(t.machines)
          .values({
            workspaceId,
            id: row.id as never,
            name: row.id,
            hostname: row.id,
            tokenHash: `hash_${row.id}`,
            createdAt: T0,
            lastSeenAt: row.lastSeenAt,
          } as never)
          .prepare(),
      ),
  }
}

/**
 * The janitor's reads for each of `ids` over ONE fresh database of the run's engine,
 * every workspace provisioned as `StoreDatabase.provisionWorkspace` provisions it.
 */
export async function openJanitorStore<const Ids extends readonly [string, ...string[]]>(
  ids: Ids,
): Promise<{ store: JanitorStore; slices: { readonly [K in keyof Ids]: JanitorSlice } }> {
  let engine: TestStoreEngine
  let base: GlobalQueries
  let probeTarget: { readonly db: object }
  let location: () => Promise<string>
  let close: () => Promise<void>
  if (testStoreEngine() !== 'pg') {
    const database: SqlDatabase = openMigratedTestDatabase()
    const dir = mkdtempSync(join(tmpdir(), 'podium-janitor-reads-'))
    let copies = 0
    engine = 'sqlite'
    base = stageASeam(database)
    probeTarget = { db: database }
    location = async () => {
      copies += 1
      const path = join(dir, `copy-${copies}.db`)
      database.exec(`VACUUM INTO '${path}'`)
      return path
    }
    close = async () => {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
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
    location = async () => url
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
      const workspaceId = asWorkspaceId(id)
      const queries = legacyWorkspaceQueries(base, workspaceId)
      const slice: SliceStore = { engine, queries, probeTarget, close }
      return {
        engine,
        workspaceId,
        slice,
        reads: new JanitorReadsRepository(queries),
        seed: seedsOf(slice, workspaceId),
      }
    })
    return {
      store: { engine, base, location, close },
      slices: slices as unknown as { readonly [K in keyof Ids]: JanitorSlice },
    }
  } catch (error) {
    await close()
    throw error
  }
}
