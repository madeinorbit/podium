import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { HttpBootstrapSource, HttpDeltaSource } from '@podium/client-core/sync-stream'
import { asIssueId, asMachineId, asUserId, issueEventRowId } from '@podium/model'
import { InMemoryReplicaStore, Replica } from '@podium/sync/replica'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import WebSocket from 'ws'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'

// With PODIUM_TEST_STORE_ENGINE=pg the stores are Postgres clones (POD-6994).
const { pgBunTestRun } = await import('../test-support/pg-test-host')
const pgTeardown = await pgBunTestRun()
afterAll(async () => await pgTeardown())
const PG = process.env.PODIUM_TEST_STORE_ENGINE === 'pg'

const { Authority, DEVICE_GRADE_PRINCIPAL, GrantEdgeVisibilityPolicy, NoDelegationsGranted } =
  await import('@podium/sync')
const { fixtureWriteScope } = await import('@podium/sync/testing')
const { makeFeedVisibility } = await import('../feed-visibility')
const { openTestStore } = await import('../test-support/open-test-store')
const { testStoreRecords } = await import('../test-support/record-writer')
const { SyncWorkerClient } = await import('../sync-worker/worker-client')
const { registerSyncRoutes } = await import('./routes')

interface TestServer {
  port: number
  stop(force: boolean): void | Promise<void>
}
const runtime = globalThis as typeof globalThis & {
  Bun: {
    serve(options: {
      hostname: string
      port: number
      fetch(
        request: Request,
        server: { upgrade(request: Request): boolean },
      ): Response | Promise<Response> | undefined
      websocket: { message(): void }
    }): TestServer
  }
}

const issue = (id: string) => ({
  id: asIssueId(id),
  repoPath: '/r',
  seq: 1,
  title: 'Issue',
  description: '',
  ownerUserId: asUserId('owner'),
  visibility: 'personal' as const,
  createdByActor: 'owner',
  createdByOnBehalfOf: asUserId('owner'),
  stage: 'backlog',
  worktreePath: null,
  branch: null,
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  machineId: asMachineId('machine'),
  linearId: null,
  linearIdentifier: null,
  linearUrl: null,
  activityNotes: null,
  notesUpdatedAt: null,
  suggestedStage: null,
  suggestedReason: null,
  blockedBy: [] as string[],
  dependencyNote: null,
  prUrl: null,
  priority: 2,
  type: 'task',
  assignee: null,
  parentId: null,
  acceptance: null,
  dueAt: null,
  deferUntil: null,
  closedReason: null,
  closedAt: null,
  supersededBy: null,
  duplicateOf: null,
  pinned: false,
  estimateMin: null,
  needsHuman: false,
  humanQuestion: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archived: false,
})

const principal = { ...DEVICE_GRADE_PRINCIPAL, user: asUserId('reader') }

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-http-'))
  const path = join(dir, 'world.db')
  const store = await openTestStore(path)
  // The store's location names its engine: the file, or the Postgres clone standing in for it.
  const worker = new SyncWorkerClient({ dbPath: store.database.location })
  const forbidden = (): never => {
    throw new Error('bootstrap read an anchor')
  }
  // The builders the worker streams, on the main thread (POD-6770).
  const built = testStoreRecords(store)
  const feed = makeFeedVisibility({
    store,
    audiencesFor: forbidden,
    authorizationRevision: forbidden,
    currentRecords: built.build,
  })
  const authority = new Authority({
    store: store.sync,
    now: () => 1,
    transact: (fn) => store.transact(fn),
    records: built,
    visibility: new GrantEdgeVisibilityPolicy(feed.state, new NoDelegationsGranted()),
    anchors: feed.anchors,
  })
  /** An issue row with `bytes` characters of text: a real record of any size,
   *  read by every member (POD-6288). In its state paragraph (the issue's body,
   *  which a first download does not carry) or in its main part. */
  let seeded = 0
  const seedIssue = async (id: string, bytes = 0, part: 'body' | 'main' = 'body') => {
    await store.issues.upsertIssue(fixtureWriteScope(), {
      ...issue(id),
      seq: ++seeded,
      ...(part === 'main' && bytes > 0 ? { acceptance: 'x'.repeat(bytes) } : {}),
    })
    if (part === 'body' && bytes > 0) {
      await store.issues.panel.save(fixtureWriteScope(), 'issuePanelState', {
        id: asIssueId(id),
        text: 'x'.repeat(bytes),
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    }
  }
  /** The feed's head: one appended change. Its payload is never read. */
  const moveHead = async () => {
    await store.sync.appendChanges(
      [{ entity: 'issueProjection', entityId: 'head', op: 'upsert', payload: '{}' }],
      1,
    )
  }
  const app = new Hono()
  app.get('/health', (c) => c.json({ ok: true }))
  registerSyncRoutes(app, {
    authority,
    worker: () => worker,
    principal: async () => principal,
    serving: {
      identity: async () => ({ feedId: 'fixture-feed', epoch: 'fixture-epoch' }),
      retentionFloor: async () => (await store.sync.minChangeSeq()) ?? 1,
    },
  })
  return {
    app,
    path,
    store,
    worker,
    authority,
    built,
    seedIssue,
    moveHead,
    async close() {
      await worker.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('cursor expiry worker reload', () => {
  it('reloads an expired client through the admitted HTTP worker with kind tokens', async () => {
    const f = await fixture()
    try {
      await f.seedIssue('current')
      await f.moveHead()
      await f.moveHead()
      const plan = await f.store.sync.planChangePrune({ keepRows: 1, maxAgeMs: 60_000, now: 1 })
      await f.store.sync.pruneChangeBatch(plan, 100)
      const builds = spyOn(f.built, 'streamAllKinds')
      const admitted = spyOn(f.worker, 'bootstrap')
      const store = new InMemoryReplicaStore()
      const oldCursor = { feedId: 'fixture-feed', epoch: 'fixture-epoch', seq: 0 }
      store.cache.installSnapshot([], oldCursor, [], undefined, { kindTokens: {} })
      const requests: string[] = []
      const deps = {
        origin: 'https://example.test',
        streamingFetch: {
          fetch: async (url: string, init: RequestInit) => {
            requests.push(`${new URL(url).pathname}${new URL(url).search}`)
            // Hono's in-process fetch does not decompress response bodies.
            const headers = new Headers(init.headers)
            headers.set('accept-encoding', 'identity')
            return await f.app.fetch(new Request(url, { ...init, headers }))
          },
        },
      }
      const bootstraps = new HttpBootstrapSource(deps)
      const deltas = new HttpDeltaSource(deps)
      const replica = new Replica({
        store: store.cache,
        unitOfWork: store.unitOfWork,
        authority: {
          bootstrap: bootstraps.bootstrap.bind(bootstraps),
          changesRange: deltas.changesRange.bind(deltas),
        },
      })
      replica.connect()
      await replica.settled()
      // The delta is refused, then the first download (POD-7085) is the
      // policy's collections. Nothing after it names kinds (POD-7086): what a
      // held record comes with, and any kind-token reload, is a collection fetch.
      expect(requests.slice(0, 2).map((r) => r.split('?')[0])).toEqual([
        '/sync/delta',
        '/sync/bootstrap',
      ])
      expect(requests[1]).toBe('/sync/bootstrap')
      for (const request of requests.slice(2))
        expect(['/sync/collections', '/sync/delta']).toContain(request.split('?')[0])
      expect(admitted).toHaveBeenCalledTimes(1)
      expect(builds).not.toHaveBeenCalled()
      expect(replica.posture).toBe('live')
      expect(replica.cursor).toEqual({ ...oldCursor, seq: 2 })
      expect(store.cache.read('issueProjection', 'current')?.value).toMatchObject({ id: 'current' })
      expect(store.cache.readKindTokens()?.issueProjection).toBeString()
      replica.transportDisconnected()
      builds.mockRestore()
      admitted.mockRestore()
    } finally {
      await f.close()
    }
  })
})

it('changes only the token whose generation was bumped, on the first download and the feed', async () => {
  const f = await fixture()
  try {
    await f.seedIssue('first', 12)
    await f.moveHead()
    const records = async (path: string) => {
      const response = await f.app.request(path, { headers: { 'accept-encoding': 'identity' } })
      expect(response.status).toBe(200)
      return (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    }
    const full = await records('/sync/bootstrap')
    const before = full[0].kindTokens
    expect(before.issuePanelState).toMatch(/:1$/)
    expect(before.issueProjection).toMatch(/:1$/)
    // A kind generation bump below the repositories, in SQL both engines run.
    await f.store.database.queries.rootDb.run(
      sql.raw(
        "INSERT INTO sync_kind (workspace_id, kind, generation) VALUES ('local', 'issuePanelState', 1) ON CONFLICT (workspace_id, kind) DO UPDATE SET generation = sync_kind.generation + 1",
      ),
    )
    const bumped = { ...before, issuePanelState: before.issuePanelState.replace(/:1$/, ':2') }
    const again = await records('/sync/bootstrap')
    expect(again[0]).toMatchObject({ seq: full[0].seq })
    expect(again[0]).not.toHaveProperty('kinds')
    expect(again[0].kindTokens).toEqual(bumped)
    // A kind-named load is no longer a route: the query is ignored, not obeyed.
    const named = await records('/sync/bootstrap?kinds=issuePanelState')
    expect(named[0]).not.toHaveProperty('kinds')
    const delta = await records('/sync/delta?feedId=fixture-feed&epoch=fixture-epoch&from=0&to=1')
    expect(delta[0].kindTokens).toEqual(bumped)
    expect(delta.at(-1)).toMatchObject({ type: 'syncComplete', seq: 1 })
  } finally {
    await f.close()
  }
})

it.each([
  'identity',
  'gzip',
  'zstd',
])('real HTTP worker %s rows equal Authority.bootstrap and certify the fixture head', async (coding) => {
  const f = await fixture()
  try {
    // The world is the model tables: two issues, one with a state paragraph.
    await f.seedIssue('first')
    await f.seedIssue('second', 64)
    await f.moveHead()
    const expected = await f.authority.bootstrap(principal)
    const head = await f.store.sync.maxChangeSeq()
    // The first download is the policy's collections (POD-7085): the open
    // issues whole, without their bodies.
    const response = await f.app.request('/sync/bootstrap', {
      headers: { 'accept-encoding': coding },
    })
    expect(response.status).toBe(200)
    const bytes = Buffer.from(await response.arrayBuffer())
    const decoded =
      coding === 'gzip' ? gunzipSync(bytes) : coding === 'zstd' ? zstdDecompressSync(bytes) : bytes
    const records = decoded
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({
      type: 'syncMeta',
      kindTokens: {},
      seq: head,
      feedId: 'fixture-feed',
      epoch: 'fixture-epoch',
    })
    expect(records.at(-1)).toMatchObject({ type: 'syncComplete', seq: head })
    // The same issue records as the Authority's bootstrap, and no body: the
    // state paragraph arrives when the issue is opened.
    type Row = { entity: string; entityId: string; value?: unknown; payload?: unknown }
    const shaped = (list: readonly Row[]) =>
      list
        .filter((row) => row.entity === 'issueProjection')
        .map((row) => ({ entityId: row.entityId, value: row.value ?? row.payload }))
        .sort((x, y) => (x.entityId < y.entityId ? -1 : x.entityId > y.entityId ? 1 : 0))
    const delivered: Row[] = records
      .filter((r) => r.type === 'feedBootstrap')
      .flatMap((r) => r.changes)
    expect(shaped(delivered)).toEqual(shaped(expected.changes as readonly Row[]))
    expect(delivered.some((row) => row.entity === 'issuePanelState')).toBe(false)
    // Every member reads every task (POD-6288): the reader gets both issues
    // and the state paragraph, each row stamped with the head number.
    expect(
      expected.changes.filter((row) => row.entity === 'issueProjection').map((row) => row.entityId),
    ).toEqual(['first', 'second'])
    expect(
      expected.changes.filter((row) => row.entity === 'issuePanelState').map((row) => row.entityId),
    ).toEqual(['second'])
    expect(expected.changes.every((row) => row.seq === head)).toBe(true)
    expect(f.worker.activeJobCount()).toBe(0)
  } finally {
    await f.close()
  }
}, 30_000)

it('worker shutdown terminates an admitted HTTP body without reader demand', async () => {
  const f = await fixture()
  try {
    const response = await f.app.request('/sync/bootstrap')
    expect(response.status).toBe(200)
    await f.worker.close()
    await expect(response.text()).rejects.toMatchObject({ reason: 'shutdown' })
    expect(f.worker.activeJobCount()).toBe(0)
  } finally {
    await f.close()
  }
}, 30_000)

it('retains worker completion metrics after client cancellation releases the body', async () => {
  const f = await fixture()
  try {
    await f.seedIssue('large', 1024 * 1024)
    await f.moveHead()
    const abort = new AbortController()
    const transfer = f.worker.bootstrap(
      {
        workspaceId: SELF_HOSTED_WORKSPACE_ID,
        transferId: 'cancel-metrics',
        principal,
        feedId: 'f',
        epoch: 'e',
        encoding: 'identity',
      },
      abort.signal,
    )
    await transfer.meta
    const reader = transfer.body.getReader()
    await reader.read()
    abort.abort()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    const completion = await transfer.completed
    expect(completion.reason).toBe('cancelled')
    expect(completion.metrics?.bytesBefore).toBeGreaterThan(0)
    expect(completion.metrics?.outcome).toBe('cancelled')
  } finally {
    await f.close()
  }
}, 30_000)

// Linux main-thread CPU, not aggregate process CPU (which includes the producer)
// and not Bun's loop-delay histogram. stat fields 14 + 15 are utime + stime.
function mainTicks() {
  const stat = readFileSync(`/proc/self/task/${process.pid}/stat`, 'utf8')
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)
  return Number(fields[11]) + Number(fields[12])
}
function p95(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!
}

it(
  '50 MiB slow bootstrap keeps same-server health and websocket ping p95 below 100 ms',
  async () => {
    const f = await fixture()
    let server: TestServer | undefined
    let socket: WebSocket | undefined
    let running = true
    const health: number[] = [],
      ping: number[] = []
    let probes: Promise<void[]> | undefined
    try {
      // 5,120 open issues, each with 10 KiB in its main part: 50 MiB of real
      // records the first download carries (a body would not be in it).
      const stateBytes = 10 * 1024
      const issues = 5120
      if (PG) {
        // A fresh Postgres test database plans with the statistics of empty tables, and a seed
        // this size outruns autovacuum: each write then scans what the seed already wrote.
        // Committed write by write and analyzed every 512 issues, the seed stays linear
        // (POD-6994). ANALYZE sees only committed rows, hence no enclosing transaction here.
        const rootDb = f.store.database.queries.rootDb as unknown as {
          run(statement: ReturnType<typeof sql.raw>): Promise<unknown>
        }
        for (let n = 0; n < issues; n++) {
          if (n > 0 && n % 512 === 0) await rootDb.run(sql.raw('ANALYZE'))
          await f.seedIssue(`issue-${n}`, stateBytes, 'main')
        }
      } else {
        await f.store.transact(async () => {
          for (let n = 0; n < issues; n++) await f.seedIssue(`issue-${n}`, stateBytes, 'main')
        })
      }
      await f.moveHead()
      server = runtime.Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request, instance) {
          if (new URL(request.url).pathname === '/ping' && instance.upgrade(request)) return
          return f.app.fetch(request)
        },
        websocket: { message() {} },
      })
      const origin = `http://127.0.0.1:${server.port}`
      socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ping`)
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', resolve)
        socket!.once('error', reject)
      })
      const ticksPerSecond = Number(
        execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim(),
      )
      expect(ticksPerSecond).toBeGreaterThan(0)
      const before = mainTicks(),
        start = performance.now()
      const healthLoop = async () => {
        while (running) {
          const t = performance.now()
          const response = await fetch(`${origin}/health`)
          expect(response.status).toBe(200)
          await response.arrayBuffer()
          health.push(performance.now() - t)
          await delay(5)
        }
      }
      const pingLoop = async () => {
        while (running) {
          const t = performance.now()
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('ping timeout')), 2000)
            socket!.once('pong', () => {
              clearTimeout(timeout)
              resolve()
            })
            socket!.ping()
          })
          ping.push(performance.now() - t)
          await delay(5)
        }
      }
      probes = Promise.all([healthLoop(), pingLoop()])
      // The first download (the policy set, POD-7085): the large stream this measures.
      const response = await fetch(`${origin}/sync/bootstrap`, {
        headers: { 'accept-encoding': 'identity' },
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      let bytes = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        await delay(2)
      }
      running = false
      await probes
      const wallMs = performance.now() - start
      const mainBusyMs = ((mainTicks() - before) / ticksPerSecond) * 1000
      const result = {
        fixturePayloadBytes: stateBytes * issues,
        bytes,
        wallMs,
        mainBusyMs,
        mainBusyPercent: (mainBusyMs / wallMs) * 100,
        healthSamples: health.length,
        healthP95Ms: p95(health),
        pingSamples: ping.length,
        pingP95Ms: p95(ping),
        budgetMs: 100,
        readerDelayMs: 2,
      }
      console.log('BOOTSTRAP_RESPONSIVENESS', JSON.stringify(result))
      expect(bytes).toBeGreaterThan(50 * 1024 * 1024)
      expect(health.length).toBeGreaterThan(20)
      expect(ping.length).toBeGreaterThan(20)
      expect(result.healthP95Ms).toBeLessThan(100)
      expect(result.pingP95Ms).toBeLessThan(100)
    } finally {
      running = false
      await probes?.catch(() => {})
      socket?.terminate()
      await server?.stop(true)
      await f.close()
    }
    // Postgres: the seed alone is 5,120 issues of two writes each, about a minute on the test
    // container; the bootstrap measured after it is held to the same budgets.
  },
  PG ? 300_000 : 60_000,
)

describe('snapshot delta producer', () => {
  const deltaPrincipal = (user: string) => ({ ...DEVICE_GRADE_PRINCIPAL, user: asUserId(user) })
  const deltaJob = (user: string) => ({
    workspaceId: SELF_HOSTED_WORKSPACE_ID,
    transferId: user,
    principal: deltaPrincipal(user),
    feedId: 'feed',
    epoch: 'epoch',
    encoding: 'identity' as const,
    deadlineMs: Date.now() + 60_000,
  })
  // A revoked grant no longer evicts (POD-6288: every member reads every
  // task), so this checks what still holds: the worker scopes a range exactly
  // as the main thread does, for each principal, across grant writes.
  it('equals main-thread scoping for a clean event window after grants, revokes and re-grants', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-delta-'))
    const path = join(dir, 'test.db')
    const store = await openTestStore(path)
    let client: InstanceType<typeof SyncWorkerClient> | undefined
    try {
      await store.issues.upsertIssue(fixtureWriteScope(), issue('shared'))
      const grant = (grantee: string) => ({
        resourceKind: 'issue',
        resourceId: 'shared',
        grantee,
        verb: 'read' as const,
        owner: 'owner',
        visibility: 'personal',
        createdAt: '2026-01-01T00:00:00.000Z',
        actorKind: 'user',
        actorId: 'owner',
        onBehalfOf: 'owner',
      })
      await store.grants.upsert(grant('reader'))
      await store.grants.upsert(grant('revoked'))
      await store.sync.appendChanges(
        [
          {
            entity: 'issueProjection',
            entityId: 'shared',
            op: 'upsert',
            payload: JSON.stringify({ id: 'shared', title: 'before' }),
          },
          { entity: 'issueProjection', entityId: 'shared', op: 'upsert', payload: '{}' },
        ],
        1,
      )
      // The window is read from the events table (POD-6766).
      const storedEventId = await store.events.appendEvent({
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'issue.created',
        subject: 'shared',
      })
      const eventId = issueEventRowId(storedEventId, 'shared')
      await store.sync.appendChanges(
        [
          {
            entity: 'issueEvent',
            entityId: eventId,
            op: 'upsert',
            payload: JSON.stringify({
              id: eventId,
              eventId: storedEventId,
              subject: 'shared',
              kind: 'created',
              ts: '2026-01-01T00:00:00.000Z',
              payload: {},
            }),
          },
        ],
        1,
      )
      const from = await store.sync.maxChangeSeq()
      await store.grants.remove('issue', 'shared', 'reader', 'read')
      await store.grants.remove('issue', 'shared', 'revoked', 'read')
      await store.sync.appendChanges(
        [
          {
            entity: 'issueProjection',
            entityId: 'shared',
            op: 'upsert',
            payload: JSON.stringify({ id: 'shared', title: 'revoked' }),
          },
          // The anchor is keyed on the normalized record (POD-4971), which every
          // issue write declares beside the old one.
          {
            entity: 'issueProjection',
            entityId: 'shared',
            op: 'upsert',
            payload: JSON.stringify({ id: 'shared', title: 'revoked' }),
          },
        ],
        2,
      )
      await store.grants.upsert(grant('reader'))
      await store.sync.appendChanges(
        [
          {
            entity: 'issueProjection',
            entityId: 'shared',
            op: 'upsert',
            payload: JSON.stringify({ id: 'shared', title: 'regranted' }),
          },
          {
            entity: 'issueProjection',
            entityId: 'shared',
            op: 'upsert',
            payload: JSON.stringify({ id: 'shared', title: 'regranted' }),
          },
        ],
        3,
      )
      const through = await store.sync.maxChangeSeq()
      const built = testStoreRecords(store)
      const feed = makeFeedVisibility({
        store,
        audiencesFor: (kind, ids) => store.grants.visibilityAudiencesFor(kind, ids),
        authorizationRevision: () => store.grants.visibilityRevision(),
        currentRecords: built.build,
      })
      const authority = new Authority({
        store: store.sync,
        now: () => 1,
        transact: (fn) => store.transact(fn),
        records: built,
        visibility: new GrantEdgeVisibilityPolicy(feed.state, new NoDelegationsGranted()),
        anchors: feed.anchors,
      })
      client = new SyncWorkerClient({ dbPath: store.database.location })
      // A fresh worker job also observes grant changes that do not advance the feed head.
      for (const revokeReader of [false, true]) {
        if (revokeReader) await store.grants.remove('issue', 'shared', 'reader', 'read')
        for (const user of ['owner', 'reader', 'revoked', 'stranger']) {
          const expected = []
          for await (const page of authority.changesRange(deltaPrincipal(user), from, through, 1))
            expected.push(page)
          const transfer = client.delta({
            ...deltaJob(user),
            mode: 'delta',
            from,
            to: through,
            pageRows: 1,
          })
          const meta = await transfer.meta
          const output = (await new Response(transfer.body).text())
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          const pages = output.filter((row) => row.type === 'feedDelta')
          expect(
            pages.map((row) => ({
              kind: 'batch',
              fromSeq: row.fromSeq,
              throughSeq: row.seq,
              changes: row.changes,
              ...(row.access ? { access: row.access } : {}),
            })),
          ).toEqual(expected)
          expect(meta).toMatchObject({ mode: 'delta', fromSeq: from, seq: through })
          expect(output.at(-1)).toMatchObject({
            type: 'syncComplete',
            seq: through,
            records: pages.length,
          })
          if (user === 'reader' && !revokeReader)
            expect(
              pages.flatMap((page) => page.changes).some((change) => change.op === 'upsert'),
            ).toBe(true)
          expect((await transfer.completed).reason).toBeUndefined()
        }
      }
    } finally {
      await client?.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
