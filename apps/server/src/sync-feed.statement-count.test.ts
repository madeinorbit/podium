/**
 * THE SYNC FEED'S OPERATIONS RUN A FIXED NUMBER OF STATEMENTS [POD-6227,
 * server-data rule 8]: a client's `hello`, a bootstrap and a catch-up delta,
 * at 5 and 200 issues and sessions in the world.
 *
 * Bootstrap and delta are pinned on the current worker paths:
 * - the sync worker's (`GET /sync/bootstrap`, `GET /sync/delta`), which every
 *   current client uses. It runs on a read-only connection the producer opens
 *   itself, so these pins count on THAT connection: the repository reads the
 *   driver probe sees, plus the producer's own raw statements, which are
 *   prepared on the handle directly and never reach a driver;
 *
 * Reads that page or chunk grow by one per page (the worker's delta reads 500
 * changes a page) or per 250 keys of one entity kind
 * (`KEY_CHUNK`, the IN-list bound); both sizes here stay inside one page and
 * one chunk, so what is pinned is the per-page cost. A bootstrap's two passes
 * over `change_latest` stream every row by design (criterion 1 lists them).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asMachineId,
  firstAdminMemberId,
  type IssueId,
  noticeRowId,
  type UserId,
} from '@podium/model'
import {
  CAP_SYNC_HTTP_V1,
  CLIENT_WIRE_VERSION,
  type Principal,
  type ServerMessage,
} from '@podium/protocol'
import { queryKey } from '@podium/runtime/query-attribution'
import type { OpenOptions, SqlDatabase } from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { describe, expect, it, vi } from 'vitest'
import type { ControlSend } from './gateway/daemon-ports'
import type { FeedServing } from './gateway/feed-serving'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import type { PgDriverOptions } from './store/executor/pg-driver'
import { probeRoundTrips, probeStatements } from './store/executor/statement-probe'
import { GrantsRepository } from './store/grants'
import { SessionsRepository } from './store/sessions'
import { produceBootstrap } from './sync-worker/producer'
import type { SyncJob } from './sync-worker/types'
import { attachTestClient } from './test-support/client-transport'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import {
  expectConstantRoundTrips,
  type RoundTripTally,
  roundTripRecorder,
} from './test-support/round-trip-count'
import {
  expectArmed,
  expectConstantStatements,
  quietShipping,
  type StatementPin,
  type StatementTally,
  tallyOf,
} from './test-support/statement-count'

/** Every read-only handle opened while a worker job is being counted. */
const worker = vi.hoisted(() => ({ onOpen: undefined as ((db: unknown) => void) | undefined }))

vi.mock('@podium/runtime/sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/runtime/sqlite')>()
  return {
    ...actual,
    openDatabase: (path: string, opts?: OpenOptions) => {
      const db = actual.openDatabase(path, opts)
      if (opts?.readOnly) worker.onOpen?.(db)
      return db
    },
  }
})

// On Postgres the worker's read session is a pool of one, and its driver is the
// statement probe's key (`sync-worker/pg-read-session.ts`, POD-6991).
vi.mock('./store/executor/pg-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store/executor/pg-driver')>()
  return {
    ...actual,
    createPgStoreDriver: (options: PgDriverOptions) => {
      const driver = actual.createPgStoreDriver(options)
      if (options.poolSize === 1) worker.onOpen?.(driver)
      return driver
    },
  }
})

interface World {
  dir: string
  path: string
  store: SessionStore
  reg: SessionRegistry
  owner: UserId
  issues: IssueId[]
  /** The head before the delta's writes, when the world made some. */
  from: number
}

/** `size` issues and `size` sessions on a file store, so the worker can open it. */
async function world(size: number, delta = false): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'pod-6227-sync-feed-'))
  const path = join(dir, 'podium.db')
  const store = await openTestStore(path)
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, answeringRepoScans(reg), { repos: ['/repo'] })
  // The attach scans the machine's checkouts. Finish that scan here, before the
  // world's head is read: left to its timeout it wrote a checkout change 10 s
  // later, inside the delta's window on a slow enough run (POD-7061).
  await reg.modules.checkouts.rescan(store.hostMachineId)
  await quietShipping(reg)
  const owner = await firstAdminMemberId(store)
  const issues: IssueId[] = []
  for (let i = 0; i < size; i++) {
    // An explicit parent: create would otherwise probe the repo for its base
    // branch (POD-2065), which the test daemon never answers (3 s per issue).
    const created = await reg.issues.crud.create(reg.issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: `Issue ${i}`,
      startNow: false,
      parentBranch: 'main',
    })
    issues.push(created.id)
    await reg.modules.sessions.createSession({ agentKind: 'codex', cwd: `/other/w${i}` })
  }
  await settle(reg)
  // The registered repository's checkout at every size, written as a
  // registration change writes it: the host daemon's inventory writes it only
  // when it runs, which a short setup can finish before. The first download
  // holds every checkout (POD-7085), so the load must not see one at one size
  // and none at the other.
  await reg.modules.checkouts.registrationsChanged(asMachineId(store.hostMachineId))
  await settle(reg)
  // The notice record is part of the current bootstrap, not just an empty
  // builder whose extra query happens to change the pin (POD-6881).
  await store.notices.open({
    id: 'ntc_statement_bootstrap',
    recipientUserId: owner,
    kind: 'mention',
    subjectKind: 'issue',
    subjectId: issues[0]!,
    title: 'You were mentioned',
    dedupeKey: 'statement-bootstrap-mention',
    createdAt: '2026-11-13T00:00:00.000Z',
  })
  await settle(reg)
  const from = await store.sync.maxChangeSeq()
  if (delta) {
    for (const id of issues)
      await reg.issues.crud.update(reg.issues.reports.store.serverWriter, id, {
        title: `Renamed ${id}`,
      })
    await settle(reg)
  }
  // The feed identity is minted on first use and cached; mint it here.
  await (reg.syncDelta.serving as FeedServing).identity()
  return { dir, path, store, reg, owner, issues, from }
}

/**
 * A fake daemon that answers a repo scan the way a real one does: each root it
 * was asked about is a repository. Without an answer the scan waits out its
 * timeout and writes its checkouts then, at a time no pin controls.
 */
function answeringRepoScans(reg: SessionRegistry): ControlSend {
  return (message) => {
    if (message.type !== 'scanReposRequest') return
    void reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'scanReposResult',
      requestId: message.requestId,
      repositories: message.roots.map((path) => ({ path, kind: 'repository', worktrees: [] })),
      diagnostics: [],
    })
  }
}

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

const teardown = async (w: World) => {
  await w.reg.dispose()
  await w.store.close()
  rmSync(w.dir, { recursive: true, force: true })
}

const principalOf = (w: World): Principal =>
  ({ ...DEVICE_GRADE_PRINCIPAL, user: w.owner }) as Principal

/**
 * Count what a worker job runs on the read-only handle it opens: every
 * statement the driver probe sees there, and every statement the producer
 * prepares on the handle itself (any text the driver did not run).
 */
async function countWorker(run: () => unknown): Promise<{ result: unknown } & StatementTally> {
  const driven: string[] = []
  const prepared: string[] = []
  const detachers: (() => void)[] = []
  worker.onOpen = (db) => {
    detachers.push(
      probeStatements({ db: db as object }, (observation) => driven.push(observation.sql)),
    )
    // A SQLite handle's own prepares are the producer's raw statements; a Postgres
    // session has none outside the probe.
    const handle = db as Partial<SqlDatabase>
    if (typeof handle.prepare !== 'function') return
    const prepare = handle.prepare.bind(handle)
    handle.prepare = (sql: string) => {
      prepared.push(sql)
      return prepare(sql)
    }
  }
  let result: unknown
  try {
    result = await run()
  } finally {
    worker.onOpen = undefined
    for (const detach of detachers) detach()
  }
  const viaDriver = new Set(driven)
  const raw = prepared.filter((sql) => !viaDriver.has(sql))
  return { result, ...tallyOf([...driven, ...raw].map(queryKey)) }
}

/**
 * The round trips a worker job makes on the handle it opens (POD-6992): the driver calls
 * that wait for the server, by the Postgres driver's pipelining, and one for each
 * statement the producer prepared on the handle itself, which no driver call carries.
 * SQLite's job opens its transaction with a raw BEGIN on the handle, so its statements read
 * as root ones; the Postgres session (`sync-worker/pg-read-session.ts`) sends its BEGIN
 * with the first statement and ends the transaction when it closes: one round trip more.
 * (A job given an idle budget sets it first, which carries the BEGIN: one more again.)
 */
async function countWorkerTrips(run: () => unknown): Promise<{ result: unknown } & RoundTripTally> {
  const recorder = roundTripRecorder()
  const driven: string[] = []
  const prepared: string[] = []
  const detachers: (() => void)[] = []
  worker.onOpen = (db) => {
    detachers.push(probeRoundTrips({ db: db as object }, recorder.onTrip))
    detachers.push(
      probeStatements({ db: db as object }, (observation) => {
        driven.push(observation.sql)
        recorder.onStatement()
      }),
    )
    // Only a SQLite handle prepares statements of its own (see countWorker).
    const handle = db as Partial<SqlDatabase>
    if (typeof handle.prepare !== 'function') return
    const prepare = handle.prepare.bind(handle)
    handle.prepare = (sql: string) => {
      prepared.push(sql)
      return prepare(sql)
    }
  }
  let result: unknown
  try {
    result = await run()
  } finally {
    worker.onOpen = undefined
    for (const detach of detachers) detach()
  }
  const viaDriver = new Set(driven)
  const raw = prepared.filter((sql) => !viaDriver.has(sql))
  const tally = recorder.tally()
  const byCall = new Map(tally.byCall)
  for (const sql of raw)
    byCall.set(`raw: ${queryKey(sql)}`, (byCall.get(`raw: ${queryKey(sql)}`) ?? 0) + 1)
  return {
    result,
    roundTrips: tally.roundTrips + raw.length + (tally.statements + raw.length > 0 ? 1 : 0),
    statements: tally.statements + raw.length,
    byCall:
      tally.statements + raw.length > 0
        ? new Map([...byCall, ['close-rollback (read)', 1]])
        : byCall,
  }
}

/** Drain a worker job and return its records. */
async function records(w: World, job: SyncJob): Promise<{ type: string; changes?: unknown[] }[]> {
  let text = ''
  for await (const chunk of produceBootstrap(
    w.store.database.location,
    job,
    new AbortController().signal,
    () => {},
  )) {
    text += new TextDecoder().decode(chunk)
  }
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

const job = (w: World, extra: Partial<SyncJob> = {}): SyncJob =>
  ({
    transferId: 'pin',
    principal: principalOf(w),
    feedId: 'feed',
    epoch: 'epoch',
    encoding: 'identity',
    deadlineMs: Date.now() + 60_000,
    ...extra,
  }) as SyncJob

const rowsOf = (out: { type: string; changes?: unknown[] }[], type: string) =>
  out.filter((record) => record.type === type).flatMap((record) => record.changes ?? [])

/**
 * Plant a read per issue of the world where the operation reads the head of
 * the change log: the spy asks the same repository once more per issue, so the
 * planted reads run on the operation's own connection (the worker's snapshot,
 * or the store's).
 */
const plantPerIssue = (w: World): (() => void) => {
  const original = SyncRepository.prototype.maxChangeSeq
  const spy = vi.spyOn(SyncRepository.prototype, 'maxChangeSeq').mockImplementation(async function (
    this: SyncRepository,
  ) {
    for (let i = 0; i < w.issues.length; i++) await original.call(this)
    return await original.call(this)
  })
  return () => spy.mockRestore()
}

/**
 * Plant a read per issue of the world on the worker's own connection: the
 * visibility prefetch reads the batch's sessions once, and the spy reads one
 * session more per issue, on the same repository. It was planted on the grants
 * read until that read left the prefetch: tasks are shared and sessions private,
 * so neither kind's grants decide anything (POD-6288, POD-6283), and grants are
 * read only for the custody of machines that tasks are homed on, which this
 * world's tasks are not.
 */
const plantPerSessionRead = (w: World): (() => void) => {
  const original = SessionsRepository.prototype.getSessions
  const spy = vi
    .spyOn(SessionsRepository.prototype, 'getSessions')
    .mockImplementation(async function (
      this: SessionsRepository,
      ...args: Parameters<SessionsRepository['getSessions']>
    ) {
      for (const id of w.issues) await original.call(this, [id])
      return await original.apply(this, args)
    })
  return () => spy.mockRestore()
}

/**
 * The delta's counterpart: a delta reads no sessions, so the loop is planted on
 * its grant-audiences read (the anchors' audience of each issue in the batch),
 * one more read per issue, on the same repository.
 */
const plantPerAudienceRead = (w: World): (() => void) => {
  const original = GrantsRepository.prototype.visibilityAudiencesFor
  const spy = vi
    .spyOn(GrantsRepository.prototype, 'visibilityAudiencesFor')
    .mockImplementation(async function (
      this: GrantsRepository,
      ...args: Parameters<GrantsRepository['visibilityAudiencesFor']>
    ) {
      for (const id of w.issues) await original.call(this, 'issue', [id])
      return await original.apply(this, args)
    })
  return () => spy.mockRestore()
}

const pin = (
  name: string,
  setup: (size: number) => Promise<World>,
  run: (w: World) => Promise<unknown>,
  check: (result: unknown, w: World, size: number) => void,
  onWorker = false,
): StatementPin<World> => ({
  name,
  setup,
  target: (w) => w.store,
  ...(onWorker ? { count: (_w: World, go: () => unknown) => countWorker(go) } : {}),
  run,
  check,
  teardown,
})

describe('sync worker: pinned statement counts at 5 and 200', () => {
  const bootstrap = pin(
    'worker bootstrap',
    (size) => world(size),
    async (w) => await records(w, job(w)),
    (result, _w, size) => {
      const out = result as { type: string; changes?: { entity: string }[] }[]
      const rows = rowsOf(out, 'feedBootstrap') as { entity: string; entityId: string }[]
      expect(new Set(rows.map((row) => `${row.entity}:${row.entityId}`)).size).toBe(rows.length)
      expect(rows.filter((row) => row.entity === 'issueProjection')).toHaveLength(size)
      expect(rows.filter((row) => row.entity === 'session')).toHaveLength(size)
      expect(rows.filter((row) => row.entity === 'inboxNotice')).toMatchObject([
        { entity: 'inboxNotice', entityId: noticeRowId(_w.owner, 'ntc_statement_bootstrap') },
      ])
    },
    true,
  )

  // The snapshot's head, floor and kind generations, then for each of the 37 kinds its
  // builder reads (one or a few statements per page) and the sharing
  // rules' reads for that page. The count is per PAGE of 500 records, by
  // design: it is the same at 5 and 200 rows, and a kind with more than one
  // page pays its reads once per page. Before, it was two passes over
  // `change_latest` and one prefetch for the whole world.
  // POD-6791 shares the issue/body-header read; the kind-generation read adds one: 65.
  // RE-PINNED 64 -> 67 FOR POD-7061: the world's checkout is now written before it is
  // counted (its daemon answers the attach scan). 64 counted an empty checkout kind only
  // because the unanswered scan wrote that row 10 s later; the row's sharing reads
  // (admin users, checkout paths, grants) are the three, once per page.
  // POD-7104 answers the asking sessions from an index on a derived column, so
  // the first download no longer reads offers and checkpoints for it: 80. The first
  // download (POD-7085) reads by collection, not kind by kind, so POD-7061's three
  // checkout reads are inside those 80 (measured at the merge, POD-7118).
  // POD-7153 skips records already sent by a preceding collection, instead of
  // building and discarding them. The issue-access reader is also thin. SQLite
  // and Postgres now both execute 78 statements (79 trips including close),
  // with complete, unique issue/session output at both sizes.
  // POD-6881 adds the notice builder: 79 statements / 80 trips. The fixture
  // above carries a real recipient notice and the output check proves it arrives.
  it('a bootstrap for the owner', async () => {
    await expectConstantStatements(bootstrap, 79)
  })

  it('a bootstrap pin is armed', async () => {
    await expectArmed(bootstrap, 79, plantPerSessionRead)
  })

  // ROUND TRIPS ON HOSTED POSTGRES [POD-6992, POD-6958 design 2.11]: the worker's read
  // session's driver calls that wait for the server, by the Postgres driver's pipelining.
  // About 2.6 ms each on hosted Postgres; docs/measurements/pod-6958-hosted-round-trips.md.
  it('a bootstrap for the owner: round trips', async () => {
    await expectConstantRoundTrips(bootstrap, 80, (_w, go) => countWorkerTrips(go))
  }, 60_000)

  const delta = pin(
    'worker delta',
    (size) => world(size, true),
    // One page, whatever the size: a page is one read by design (see the header).
    async (w) => await records(w, job(w, { mode: 'delta', from: w.from, pageRows: 10_000 })),
    (result, _w, size) => {
      const rows = rowsOf(result as { type: string; changes?: unknown[] }[], 'feedDelta') as {
        entity: string
      }[]
      expect(rows.filter((row) => row.entity === 'issueProjection')).toHaveLength(size)
    },
    true,
  )

  // The producer's head, floor and kind generations, the page of changes, and the batch
  // prefetch's reads (issues, grant audiences, sessions). RE-PINNED 8 -> 7 FOR
  // POD-6341: the prefetch's issue grants read (#9119be47) left with POD-6288
  // (tasks are shared, design §2.2, §4.1). RE-PINNED 7 -> 6 FOR POD-6766: the
  // issue-event subjects are no longer read from change_latest up front.
  it('a delta over one rename of every issue', async () => {
    await expectConstantStatements(delta, 6)
  })

  it('a delta pin is armed', async () => {
    await expectArmed(delta, 6, plantPerAudienceRead)
  })
})

describe('client hello: pinned statement counts at 5 and 200', () => {
  interface Client extends World {
    clientId: string
    inbox: ServerMessage[]
  }

  /** A client attached, its attach work finished, before the counted hello. */
  const connected = async (size: number): Promise<Client> => {
    const w = await world(size)
    const inbox: ServerMessage[] = []
    const clientId = attachTestClient(w.reg.clientGateway, (message) => inbox.push(message))
    await settle(w.reg)
    return { ...w, clientId, inbox }
  }

  const hello = (c: Client, feedCursor?: unknown, caps = [CAP_SYNC_HTTP_V1]) =>
    c.reg.clientGateway.routeClientFrame(c.clientId, {
      type: 'hello',
      caps,
      wireVersion: CLIENT_WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      ...(feedCursor ? { feedCursor } : {}),
    } as never)

  const helloPin = (
    name: string,
    cursor: (c: Client) => Promise<unknown>,
  ): StatementPin<World> => ({
    name,
    setup: connected,
    target: (w) => w.store,
    run: async (w) => {
      const c = w as Client
      await hello(c, await cursor(c))
      await (c.reg.syncDelta.serving as FeedServing).admissionSettled()
      await settle(c.reg)
    },
    check: (_result, w) => {
      expect((w as Client).inbox.some((message) => message.type === 'feedResume')).toBe(true)
      expect((w as Client).inbox).toContainEqual(
        expect.objectContaining({
          type: 'welcome',
          kindTokens: expect.objectContaining({ issueProjection: expect.stringMatching(/:1$/) }),
        }),
      )
    },
    teardown,
  })

  const fresh = helloPin('hello without a cursor', async () => undefined)

  // The head it is admitted at and the kind generations.
  it('a hello without a cursor is admitted at the head', async () => {
    await expectConstantStatements(fresh, 2)
  })

  it('a hello pin is armed', async () => {
    await expectArmed(fresh, 2, plantPerIssue)
  })

  it('a hello that resumes from a cursor', async () => {
    await expectConstantStatements(
      helloPin('hello with a cursor', async (c) => ({
        ...(await (c.reg.syncDelta.serving as FeedServing).identity()),
        seq: c.from,
      })),
      // The head, retention floor and kind generations.
      3,
    )
  })

  it('resumes and advertises tokens without a shape-version capability', async () => {
    const c = await connected(5)
    try {
      const serving = c.reg.syncDelta.serving as FeedServing
      const cursor = { ...(await serving.identity()), seq: c.from }
      await hello(c, cursor, [CAP_SYNC_HTTP_V1])
      await serving.admissionSettled()
      expect(c.inbox).toContainEqual(expect.objectContaining({ type: 'feedResume' }))
      expect(c.inbox.some((message) => message.type === 'feedResyncRequired')).toBe(false)
      expect(
        c.inbox.some((message) => message.type === 'welcome' && message.kindTokens !== undefined),
      ).toBe(true)
    } finally {
      await teardown(c)
    }
  })
})
