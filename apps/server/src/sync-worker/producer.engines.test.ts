/**
 * THE SYNC WORKER'S PRODUCER ON THE STORE'S ENGINES [POD-6991, POD-6958 design 2.9].
 *
 * The producer opens a read session on the store's own engine (`read-session.ts`):
 * SQLite on the store lane, Postgres on `server-store-pg`. What this file holds on both:
 *
 *  - the first read fixes the snapshot: rows and changes written after it, while the
 *    job is still streaming, are not in the job's output;
 *  - the session cannot write;
 *  - the job releases its snapshot when it ends, also when it is aborted;
 *  - a job runs the same statements on both engines.
 *
 * The world is the sync, session and layout repositories' slice of a store
 * (`openSliceStore`'s pattern), on a database the worker can open by its location: a WAL
 * file on SQLite, a clone of the run's template on Postgres. A bootstrap here reads one
 * kind, a person's layout, and a delta session changes: every read either makes runs on
 * Postgres today. A full bootstrap also reads the groups whose Postgres forms have not
 * landed (the events reads, POD-6988, among them), and the full worker suites
 * (`sync/bootstrap-worker.bun.test.ts`, `sync-feed.statement-count.test.ts`) open a whole
 * `SessionStore`, which waits for one that boots on Postgres (POD-6994).
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asSessionId, asUserId, layoutRowId } from '@podium/model'
import { SyncComplete, SyncMeta } from '@podium/protocol'
import { queryKey } from '@podium/runtime/query-attribution'
import {
  type OpenOptions,
  openDatabase,
  type SqlDatabase,
  serializeDatabase,
} from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncServerTables } from '../migrations/sync-server-tables'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { provisionWorkspaceFeed } from '../store/database'
import type { QueryClient } from '../store/executor/driver'
import { createStoreExecutor, type RootStoreExecutor } from '../store/executor/executor'
import type { PgDriverOptions } from '../store/executor/pg-driver'
import { createPgStoreDriver } from '../store/executor/pg-driver'
import { pgQueryLayer } from '../store/executor/pg-drizzle'
import { probeStatements } from '../store/executor/statement-probe'
import { type GlobalQueries, legacyWorkspaceQueries } from '../store/executor/sync-drizzle'
import { SessionsRepository } from '../store/sessions'
import type { SessionRow } from '../store/types'
import { UserLayoutRepository } from '../store/user-layout'
import { drainedRepository } from '../test-support/drained-repository'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { PG_SLICE_TABLES, type SliceStore } from '../test-support/pg-slice-tables'
import { clonePgTestDatabase, testStoreEngine } from '../test-support/pg-test-database'
import { stageASeam } from '../test-support/stage-a-seam'
import {
  expectConstantStatements,
  type StatementPin,
  tallyOf,
} from '../test-support/statement-count'
import { produceBootstrap } from './producer'
import { openWorkerReadSession } from './read-session'
import type { SyncJob } from './types'

/** The connection key of every read session opened while `onOpen` is set. */
const opened = vi.hoisted(() => ({ onOpen: undefined as ((key: object) => void) | undefined }))

// The SQLite session's read-only handle is its statement probe's key.
vi.mock('@podium/runtime/sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/runtime/sqlite')>()
  return {
    ...actual,
    openDatabase: (path: string, options?: OpenOptions) => {
      const db = actual.openDatabase(path, options)
      if (options?.readOnly) opened.onOpen?.(db)
      return db
    },
  }
})

// The Postgres session's pool of one is its statement probe's key.
vi.mock('../store/executor/pg-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/executor/pg-driver')>()
  return {
    ...actual,
    createPgStoreDriver: (options: PgDriverOptions) => {
      const driver = actual.createPgStoreDriver(options)
      if (options.poolSize === 1) opened.onOpen?.(driver)
      return driver
    },
  }
})

const ENGINE = testStoreEngine()
const ALICE = asUserId('user:alice')
const T0 = '2026-09-01T00:00:00.000Z'

/** A store the worker opens by its location, with the writers the tests seed through. */
interface World extends SliceStore {
  /** What the producer is given: the SQLite file's path or the Postgres URL. */
  readonly location: string
  readonly sessions: SessionsRepository
  readonly layout: UserLayoutRepository
  readonly sync: SyncRepository
  /** Read sessions holding a snapshot open now, other than the world's own writers. */
  openSnapshots(): Promise<number>
}

async function openWorld(): Promise<World> {
  let base: GlobalQueries
  let location: string
  let close: () => Promise<void>
  let openSnapshots: () => Promise<number>
  let probeTarget: { db: object }
  if (ENGINE === 'pg') {
    const { url } = await clonePgTestDatabase()
    const executor: RootStoreExecutor<QueryClient> = createStoreExecutor<QueryClient>({
      driver: createPgStoreDriver({ url, poolSize: 2 }),
      queryLayer: pgQueryLayer(PG_SLICE_TABLES),
      startOpen: true,
    })
    base = executor.queries
    location = url
    probeTarget = { db: {} }
    close = async () => await executor.close()
    openSnapshots = async () => {
      const row = (await base.rootDb.get(
        sql.raw(
          'SELECT count(*)::int AS open FROM pg_stat_activity ' +
            'WHERE datname = current_database() AND pid <> pg_backend_pid() ' +
            'AND xact_start IS NOT NULL',
        ),
      )) as { open: number }
      return row.open
    }
  } else {
    // A WAL file at the head of the migration chain, so the worker's read-only
    // connection and the writer's run side by side.
    const dir = mkdtempSync(join(tmpdir(), 'producer-engines-'))
    location = join(dir, 'store.db')
    const image = openMigratedTestDatabase()
    writeFileSync(location, serializeDatabase(image))
    image.close()
    const db: SqlDatabase = openDatabase(location)
    db.exec('PRAGMA journal_mode = WAL')
    base = stageASeam(db)
    probeTarget = { db }
    close = async () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
    // A reader holding a snapshot keeps a full checkpoint from finishing.
    openSnapshots = async () =>
      (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy
  }
  await base.createOrJoinTransaction(async () => {
    await provisionWorkspaceFeed(base.db).run({
      workspaceId: SELF_HOSTED_WORKSPACE_ID,
      feedId: randomUUID(),
      epoch: randomUUID(),
      mintedAt: 0,
    })
  })
  const queries = legacyWorkspaceQueries(base, SELF_HOSTED_WORKSPACE_ID)
  const slice: SliceStore = { engine: ENGINE, queries, probeTarget, close }
  return {
    ...slice,
    location,
    sessions: drainedRepository(slice, new SessionsRepository(queries)),
    layout: drainedRepository(slice, new UserLayoutRepository(queries)),
    sync: new SyncRepository(queries, syncServerTables, SELF_HOSTED_WORKSPACE_ID),
    openSnapshots,
  }
}

function session(id: string): SessionRow {
  return {
    id: asSessionId(id),
    ownerUserId: ALICE,
    agentKind: 'claude-code',
    cwd: '/home/u/repo',
    title: `session ${id}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: 'label',
    createdAt: T0,
    lastActiveAt: T0,
    geometry: { cols: 80, rows: 24 },
    archived: false,
    workState: null,
    machineId: asMachineId('machine-1'),
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
  } as SessionRow
}

/** Alice's sessions `ids`, and one change per session in the feed. */
async function seed(w: World, ids: readonly string[]): Promise<void> {
  for (const id of ids) await w.sessions.upsertSession(fixtureWriteScope(), session(id))
  await w.sync.appendChanges(
    ids.map((id) => ({ entity: 'session', entityId: id, op: 'upsert', payload: '{}' })),
    1,
  )
}

/** A layout key of Alice's: one of the dynamic sidebar section keys. */
const section = (name: string) => `sidebar.section.${name}`

/** Alice's layout keys `names`, and one change per key in the feed. */
async function seedLayout(w: World, names: readonly string[]): Promise<void> {
  const values = Object.fromEntries(names.map((name) => [section(name), true]))
  await w.layout.setMany(fixtureWriteScope(), ALICE, values, T0)
  await w.sync.appendChanges(
    names.map((name) => ({
      entity: 'userLayout',
      entityId: layoutRowId(ALICE, section(name)),
      op: 'upsert',
      payload: '{}',
    })),
    1,
  )
}

const layoutRows = (names: readonly string[]) =>
  names.map((name) => layoutRowId(ALICE, section(name))).sort()

const job = (extra: Partial<SyncJob> = {}): SyncJob =>
  ({
    workspaceId: SELF_HOSTED_WORKSPACE_ID,
    transferId: 'job',
    principal: { ...DEVICE_GRADE_PRINCIPAL, user: ALICE },
    feedId: 'feed',
    epoch: 'epoch',
    encoding: 'identity',
    deadlineMs: Date.now() + 60_000,
    ...extra,
  }) as SyncJob

/**
 * The layout rows alone, as the collection fetch names them (POD-7085 retired the
 * kind-named load): one collection, so the job reads one kind's rows.
 */
const LAYOUT_ONLY: Partial<SyncJob> = {
  mode: 'collections',
  instances: [{ collection: 'userLayout.all' }],
}

type Line = { type: string; seq?: number; changes?: { entityId: string; seq: number }[] }

/**
 * Drain a job, calling `afterFirst` once its first chunk (the meta line, at least) is
 * out. A chunk may end inside a line, so lines are split only at the end.
 */
async function drain(w: World, request: SyncJob, afterFirst?: () => Promise<void>) {
  const decoder = new TextDecoder()
  let text = ''
  let first = true
  for await (const chunk of produceBootstrap(
    w.location,
    request,
    new AbortController().signal,
    () => {},
  )) {
    text += decoder.decode(chunk, { stream: true })
    if (first) await afterFirst?.()
    first = false
  }
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line)
}

const changesOf = (out: Line[], type: string) =>
  out.filter((line) => line.type === type).flatMap((line) => line.changes ?? [])

describe(`the producer's read session [${ENGINE}]`, () => {
  let w: World

  beforeEach(async () => {
    w = await openWorld()
  })

  afterEach(async () => {
    await w.close()
  })

  it('streams a bootstrap from the snapshot its first read fixed', async () => {
    await seedLayout(w, ['a', 'b', 'c'])
    const head = await w.sync.maxChangeSeq()
    const out = await drain(w, job(LAYOUT_ONLY), async () => {
      // Written while the job streams: after its snapshot.
      await seedLayout(w, ['d'])
    })
    expect(SyncMeta.safeParse(out[0]).success).toBe(true)
    expect(out[0]?.seq).toBe(head)
    const rows = changesOf(out, 'feedBootstrap')
    expect(rows.map((row) => row.entityId).sort()).toEqual(layoutRows(['a', 'b', 'c']))
    expect(rows.every((row) => row.seq === head)).toBe(true)
    expect(SyncComplete.safeParse(out.at(-1)).success).toBe(true)
    expect(out.at(-1)?.seq).toBe(head)
    // The write committed: a new job sees it.
    expect(await w.sync.maxChangeSeq()).toBeGreaterThan(head)
    const next = changesOf(await drain(w, job(LAYOUT_ONLY)), 'feedBootstrap')
    expect(next.map((row) => row.entityId).sort()).toEqual(layoutRows(['a', 'b', 'c', 'd']))
  })

  it('streams a delta from the snapshot its first read fixed', async () => {
    await seed(w, ['s1'])
    const from = await w.sync.maxChangeSeq()
    await seed(w, ['s2', 's3'])
    const head = await w.sync.maxChangeSeq()
    const out = await drain(w, job({ mode: 'delta', from }), async () => {
      await seed(w, ['s4'])
    })
    expect(out[0]).toMatchObject({ type: 'syncMeta', mode: 'delta', seq: head, fromSeq: from })
    const changes = changesOf(out, 'feedDelta')
    expect(changes.map((change) => change.entityId).sort()).toEqual(['s2', 's3'])
    expect(out.at(-1)).toMatchObject({ type: 'syncComplete', seq: head })
  })

  // POD-7589: the maintenance prune commits between the delta's pages. The snapshot
  // the job's first read fixed still holds every row of the range, so the transfer
  // completes whole; a delta started after the prune is refused.
  it('serves a whole delta when a prune commits between its pages', async () => {
    await seed(w, ['s1'])
    const from = await w.sync.maxChangeSeq()
    await seed(w, ['s2', 's3', 's4'])
    const head = await w.sync.maxChangeSeq()
    const read = SyncRepository.prototype.changesInRange
    let pruned = 0
    const pages = vi
      .spyOn(SyncRepository.prototype, 'changesInRange')
      .mockImplementation(async function (this: SyncRepository, ...args) {
        const page = await read.apply(this, args)
        // The job's own repository, after its first page: the writer prunes.
        if (this !== w.sync && pruned === 0)
          pruned = await w.sync.pruneChangeBatch({ thresholdSeq: head - 1 }, 100)
        return page
      })
    try {
      const out = await drain(w, job({ mode: 'delta', from, pageRows: 1 }))
      expect(pruned).toBeGreaterThan(0)
      expect(pages.mock.calls.length).toBeGreaterThan(1)
      const frames = out.filter((line) => line.type === 'feedDelta') as (Line & {
        fromSeq: number
      })[]
      // Contiguous frames over the whole range: nothing was skipped.
      expect(frames[0]?.fromSeq).toBe(from)
      for (let i = 1; i < frames.length; i++) expect(frames[i]?.fromSeq).toBe(frames[i - 1]?.seq)
      expect(frames.at(-1)?.seq).toBe(head)
      expect(changesOf(out, 'feedDelta').map((change) => change.entityId)).toEqual([
        's2',
        's3',
        's4',
      ])
      expect(out.at(-1)).toMatchObject({ type: 'syncComplete', seq: head })
    } finally {
      pages.mockRestore()
    }
    // The prune committed: the same cursor now needs a new start-up load.
    await expect(drain(w, job({ mode: 'delta', from }))).rejects.toMatchObject({
      reason: 'compacted-or-unknown',
    })
  })

  it('refuses a write', async () => {
    await seed(w, ['s1'])
    const reader = await openWorkerReadSession(w.location)
    try {
      await expect(
        reader.executor.queries.rootDb.run(
          sql`DELETE FROM sync_feed WHERE workspace_id = ${SELF_HOSTED_WORKSPACE_ID}`,
        ),
      ).rejects.toThrow()
    } finally {
      await reader.close()
    }
    // The feed row is still there to read.
    expect((await w.sync.readFeedState()).headSeq).toBe(await w.sync.maxChangeSeq())
  })

  // A job waits on its client between pages; the server must not end its transaction
  // for idling before the job's deadline does. SQLite has no such limit.
  it.runIf(ENGINE === 'pg')('lets its transaction idle for the job time left', async () => {
    const reader = await openWorkerReadSession(w.location, { idleBudgetMs: 123_456 })
    try {
      // A declared read: a raw drizzle statement is taken for a write.
      const row = (await reader.executor.drizzle.get(
        "SELECT current_setting('idle_in_transaction_session_timeout') AS idle",
      )) as { idle: string }
      expect(row.idle).toBe('123456ms')
    } finally {
      await reader.close()
    }
  })

  it('releases its snapshot when the job completes and when it is aborted', async () => {
    // Several frames of 500 rows, so the job is still streaming when it is aborted.
    await seedLayout(
      w,
      Array.from({ length: 1_600 }, (_, i) => `k${i}`),
    )
    await drain(w, job(LAYOUT_ONLY))
    expect(await w.openSnapshots()).toBe(0)
    const abort = new AbortController()
    const producer = produceBootstrap(w.location, job(LAYOUT_ONLY), abort.signal, () => {})
    expect((await producer.next()).done).toBe(false)
    // A commit past the job's snapshot, which a SQLite checkpoint cannot pass.
    await seedLayout(w, ['c'])
    expect(await w.openSnapshots()).toBeGreaterThan(0)
    abort.abort(new Error('cancelled'))
    // A chunk the encoder already holds may still come out; then the job ends cancelled.
    const ending = (async () => {
      while (!(await producer.next()).done) {}
    })()
    await expect(ending).rejects.toMatchObject({ reason: 'cancelled' })
    expect(await w.openSnapshots()).toBe(0)
  })
})

/** Count what a job runs on the read session it opens, on either engine. */
async function countJob(run: () => unknown) {
  const seen: string[] = []
  const detachers: (() => void)[] = []
  opened.onOpen = (key) => {
    detachers.push(probeStatements({ db: key }, (observation) => seen.push(observation.sql)))
  }
  let result: unknown
  try {
    result = await run()
  } finally {
    opened.onOpen = undefined
    for (const detach of detachers) detach()
  }
  return { result, ...tallyOf(seen.map(queryKey)) }
}

describe(`the producer's statements [${ENGINE}]`, () => {
  const ids = (size: number) => Array.from({ length: size }, (_, i) => `s${i}`)
  /** A bootstrap reads Alice's layout keys; a delta the session changes after `from`. */
  const pin = (
    name: string,
    mode: 'snapshot' | 'delta',
    request: (from: number) => SyncJob,
  ): StatementPin<World & { from: number }> => ({
    name,
    async setup(size) {
      const world = await openWorld()
      const write = mode === 'delta' ? seed : seedLayout
      await write(world, ['before'])
      const from = await world.sync.maxChangeSeq()
      await write(world, ids(size))
      return { ...world, from }
    },
    target: (world) => world.probeTarget,
    count: async (_world, run) => await countJob(run),
    run: async (world) => await drain(world, request(world.from)),
    check(result, _world, size) {
      const out = result as Line[]
      // A delta carries the changes after `from`; a bootstrap every key.
      if (mode === 'delta') expect(changesOf(out, 'feedDelta')).toHaveLength(size)
      else expect(changesOf(out, 'feedBootstrap')).toHaveLength(size + 1)
    },
    teardown: async (world) => await world.close(),
  })

  // The same on both engines: the snapshot's BEGIN rides with the first read on
  // Postgres and is a handle command on SQLite, so neither is a statement of the job.
  it('a filtered bootstrap', async () => {
    await expectConstantStatements(
      pin('worker layout bootstrap', 'snapshot', () => job(LAYOUT_ONLY)),
      LAYOUT_BOOTSTRAP_STATEMENTS,
    )
  })

  it('a delta', async () => {
    await expectConstantStatements(
      pin('worker session delta', 'delta', (from) =>
        job({ mode: 'delta', from, pageRows: 10_000 }),
      ),
      SESSION_DELTA_STATEMENTS,
    )
  })
})

const LAYOUT_BOOTSTRAP_STATEMENTS = 3
const SESSION_DELTA_STATEMENTS = 5
