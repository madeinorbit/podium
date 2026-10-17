/**
 * THE SYNC FEED'S OPERATIONS RUN A FIXED NUMBER OF STATEMENTS [POD-6227,
 * server-data rule 8]: a client's `hello`, a bootstrap and a catch-up delta,
 * at 5 and 200 issues and sessions in the world.
 *
 * Bootstrap and delta are pinned on both paths that serve them:
 * - the sync worker's (`GET /sync/bootstrap`, `GET /sync/delta`), which every
 *   current client uses. It runs on a read-only connection the producer opens
 *   itself, so these pins count on THAT connection: the repository reads the
 *   driver probe sees, plus the producer's own raw statements, which are
 *   prepared on the handle directly and never reach a driver;
 * - the in-process `syncChangesSince` (tRPC `sync.changesSince`, the wire-v1
 *   client), on the store's connection.
 *
 * Reads that page or chunk grow by one per page (the worker's delta reads 500
 * changes a page, the in-process one 1000) or per 250 keys of one entity kind
 * (`KEY_CHUNK`, the IN-list bound); both sizes here stay inside one page and
 * one chunk, so what is pinned is the per-page cost. A bootstrap's two passes
 * over `change_latest` stream every row by design (criterion 1 lists them).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstAdminMemberId, type IssueId, type UserId } from '@podium/model'
import { CLIENT_WIRE_VERSION, type Principal, type ServerMessage } from '@podium/protocol'
import { queryKey } from '@podium/runtime/query-attribution'
import type { OpenOptions, SqlDatabase } from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { describe, expect, it, vi } from 'vitest'
import type { FeedServing } from './gateway/feed-serving'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { probeStatements } from './store/executor/statement-probe'
import { GrantsRepository } from './store/grants'
import { produceBootstrap } from './sync-worker/producer'
import type { SyncJob } from './sync-worker/types'
import { attachTestClient } from './test-support/client-transport'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
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
  await attachHostDaemon(reg, () => {}, { repos: ['/repo'] })
  await quietShipping(reg)
  const owner = await firstAdminMemberId(store)
  const issues: IssueId[] = []
  for (let i = 0; i < size; i++) {
    issues.push((await reg.issues.crud.create({ repoPath: '/repo', title: `Issue ${i}`, startNow: false })).id)
    await reg.modules.sessions.createSession({ agentKind: 'codex', cwd: `/other/w${i}` })
  }
  await settle(reg)
  const from = await store.sync.maxChangeSeq()
  if (delta) {
    for (const id of issues) await reg.issues.crud.update(id, { title: `Renamed ${id}` })
    await settle(reg)
  }
  // The feed identity is minted on first use and cached; mint it here.
  await (reg.syncDelta.serving as FeedServing).identity()
  return { dir, path, store, reg, owner, issues, from }
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

const principalOf = (w: World): Principal => ({ ...DEVICE_GRADE_PRINCIPAL, user: w.owner }) as Principal

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
    detachers.push(probeStatements({ db: db as object }, (observation) => driven.push(observation.sql)))
    const handle = db as SqlDatabase
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

/** Drain a worker job and return its records. */
async function records(w: World, job: SyncJob): Promise<{ type: string; changes?: unknown[] }[]> {
  let text = ''
  for await (const chunk of produceBootstrap(w.path, job, new AbortController().signal, () => {})) {
    text += new TextDecoder().decode(chunk)
  }
  return text.trim().split('\n').map((line) => JSON.parse(line))
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
  const spy = vi.spyOn(SyncRepository.prototype, 'maxChangeSeq').mockImplementation(async function (this: SyncRepository) {
    for (let i = 0; i < w.issues.length; i++) await original.call(this)
    return await original.call(this)
  })
  return () => spy.mockRestore()
}

/**
 * Plant a read per issue of the world on the worker's own connection: the
 * visibility prefetch reads grants once, and the spy reads one issue's grants
 * more per issue, on the same repository.
 */
const plantPerGrantRead = (w: World): (() => void) => {
  const original = GrantsRepository.prototype.loadForResourcesOfKinds
  const spy = vi.spyOn(GrantsRepository.prototype, 'loadForResourcesOfKinds').mockImplementation(async function (
    this: GrantsRepository,
    ...args: Parameters<GrantsRepository['loadForResourcesOfKinds']>
  ) {
    for (const id of w.issues) await this.listForResources('issue', [id])
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
      const rows = rowsOf(out, 'feedBootstrap') as { entity: string }[]
      expect(rows.filter((row) => row.entity === 'issueProjection')).toHaveLength(size)
      expect(rows.filter((row) => row.entity === 'session')).toHaveLength(size)
    },
    true,
  )

  // The producer's five raw statements (the snapshot's head and floor, the two
  // passes over change_latest, the issue-event subjects) and the visibility
  // prefetch's three reads (issues, sessions, grants).
  it('a bootstrap for the owner', async () => {
    await expectConstantStatements(bootstrap, 8)
  })

  it('a bootstrap pin is armed', async () => {
    await expectArmed(bootstrap, 8, plantPerGrantRead)
  })

  const delta = pin(
    'worker delta',
    (size) => world(size, true),
    // One page, whatever the size: a page is one read by design (see the header).
    async (w) => await records(w, job(w, { mode: 'delta', from: w.from, pageRows: 10_000 })),
    (result, _w, size) => {
      const rows = rowsOf(result as { type: string; changes?: unknown[] }[], 'feedDelta') as { entity: string }[]
      expect(rows.filter((row) => row.entity === 'issueProjection')).toHaveLength(size)
    },
    true,
  )

  // The producer's head, floor and issue-event subjects, the page of changes,
  // and the batch prefetch's reads (issues, grants, grant audiences, sessions).
  it('a delta over one rename of every issue', async () => {
    await expectConstantStatements(delta, 8)
  })

  it('a delta pin is armed', async () => {
    await expectArmed(delta, 8, plantPerGrantRead)
  })
})

describe('in-process syncChangesSince: pinned statement counts at 5 and 200', () => {
  const snapshot = pin(
    'syncChangesSince(null)',
    (size) => world(size),
    async (w) => await w.reg.modules.sessions.syncChangesSince(null, principalOf(w)),
    (result, _w, size) => {
      const out = result as { kind: string; sessions: unknown[]; issueProjections: unknown[] }
      expect(out.kind).toBe('snapshot')
      expect(out.issueProjections).toHaveLength(size)
      expect(out.sessions).toHaveLength(size)
    },
  )

  it('a snapshot for the owner', async () => {
    await expectConstantStatements(snapshot, 7)
  })

  it('a snapshot pin is armed', async () => {
    await expectArmed(snapshot, 7, plantPerIssue)
  })

  const since = pin(
    'syncChangesSince(cursor)',
    (size) => world(size, true),
    async (w) => await w.reg.modules.sessions.syncChangesSince(w.from, principalOf(w)),
    (result, _w, size) => {
      const out = result as { kind: string; changes: { entity: string }[] }
      expect(out.kind).toBe('delta')
      expect(out.changes.filter((change) => change.entity === 'issueProjection')).toHaveLength(size)
    },
  )

  it('a delta over one rename of every issue', async () => {
    await expectConstantStatements(since, 8)
  })

  it('a delta pin is armed', async () => {
    await expectArmed(since, 8, plantPerIssue)
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
    await expect.poll(() => inbox.some((message) => message.type === 'approvalsChanged')).toBe(true)
    await settle(w.reg)
    return { ...w, clientId, inbox }
  }

  const hello = (c: Client, feedCursor?: unknown) =>
    c.reg.clientGateway.routeClientFrame(c.clientId, {
      type: 'hello',
      caps: ['sync.http.v1'],
      wireVersion: CLIENT_WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      ...(feedCursor ? { feedCursor } : {}),
    } as never)

  const helloPin = (name: string, cursor: (c: Client) => Promise<unknown>): StatementPin<World> => ({
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
    },
    teardown,
  })

  const fresh = helloPin('hello without a cursor', async () => undefined)

  // The head it is admitted at. The resume trace read the head a second time
  // whether tracing was on or not, until POD-6227: 2 -> 1.
  it('a hello without a cursor is admitted at the head', async () => {
    await expectConstantStatements(fresh, 1)
  })

  it('a hello pin is armed', async () => {
    await expectArmed(fresh, 1, plantPerIssue)
  })

  it('a hello that resumes from a cursor', async () => {
    await expectConstantStatements(
      helloPin('hello with a cursor', async (c) => ({
        ...(await (c.reg.syncDelta.serving as FeedServing).identity()),
        seq: c.from,
      })),
      // The head and the retention floor the cursor is checked against.
      2,
    )
  })
})
