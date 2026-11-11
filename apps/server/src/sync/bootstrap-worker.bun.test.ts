import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { asIssueId, asMachineId, asUserId, issueEventRowId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { Hono } from 'hono'
import WebSocket from 'ws'

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
  createdAt: 't0',
  updatedAt: 't0',
  archived: false,
})

const principal = { ...DEVICE_GRADE_PRINCIPAL, user: asUserId('reader') }

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-http-'))
  const path = join(dir, 'world.db')
  const store = await openTestStore(path)
  const worker = new SyncWorkerClient({ dbPath: path })
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
  /** An issue row with a state paragraph of `bytes` characters: a real record
   *  of any size, read by every member (POD-6288). */
  let seeded = 0
  const seedIssue = async (id: string, bytes = 0) => {
    await store.issues.upsertIssue(fixtureWriteScope(), { ...issue(id), seq: ++seeded })
    if (bytes > 0) {
      await store.issues.panel.save(fixtureWriteScope(), 'issuePanelState', {
        id: asIssueId(id),
        text: 'x'.repeat(bytes),
        updatedAt: 't0',
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
    seedIssue,
    moveHead,
    async close() {
      await worker.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

it('filters the snapshot and changes only the token whose generation was bumped', async () => {
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
    expect(before.issuePanelState).toMatch(/:0$/)
    expect(before.issueProjection).toMatch(/:0$/)
    const db = openDatabase(f.path)
    try {
      db.exec(
        "INSERT INTO sync_kind (tenant_id, kind, generation) VALUES ('local', 'issuePanelState', 1) ON CONFLICT (tenant_id, kind) DO UPDATE SET generation = sync_kind.generation + 1",
      )
    } finally {
      db.close()
    }
    const filtered = await records('/sync/bootstrap?kinds=issuePanelState')
    expect(filtered[0]).toMatchObject({ kinds: ['issuePanelState'], seq: full[0].seq })
    expect(filtered[0].kindTokens).toEqual({
      ...before,
      issuePanelState: before.issuePanelState.replace(/:0$/, ':1'),
    })
    expect(
      filtered
        .filter((record) => record.type === 'feedBootstrap')
        .flatMap((record) => record.changes)
        .map((row) => [row.entity, row.entityId]),
    ).toEqual([['issuePanelState', 'first']])
    expect(
      (await f.app.request('/sync/bootstrap?kinds=issuePanelState,issuePanelState')).status,
    ).toBe(400)
    const delta = await records(
      '/sync/delta?feedId=fixture-feed&epoch=fixture-epoch&from=0&to=1&omitKinds=issueProjection',
    )
    expect(delta[0].kindTokens).toEqual(filtered[0].kindTokens)
    expect(
      delta.filter((record) => record.type === 'feedDelta').flatMap((record) => record.changes),
    ).toEqual([])
    expect(delta.at(-1)).toMatchObject({ type: 'syncComplete', seq: 1, rows: 0 })
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
    expect(records.filter((r) => r.type === 'feedBootstrap').flatMap((r) => r.changes)).toEqual(
      expected.changes,
    )
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
      { transferId: 'cancel-metrics', principal, feedId: 'f', epoch: 'e', encoding: 'identity' },
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

it('50 MiB slow bootstrap keeps same-server health and websocket ping p95 below 100 ms', async () => {
  const f = await fixture()
  let server: TestServer | undefined
  let socket: WebSocket | undefined
  let running = true
  const health: number[] = [],
    ping: number[] = []
  let probes: Promise<void[]> | undefined
  try {
    // 5,120 issues, each with a 10 KiB state paragraph: 50 MiB of real records.
    const stateBytes = 10 * 1024
    const issues = 5120
    await f.store.transact(async () => {
      for (let n = 0; n < issues; n++) await f.seedIssue(`issue-${n}`, stateBytes)
    })
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
    const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
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
}, 60_000)

describe('snapshot delta producer', () => {
  const deltaPrincipal = (user: string) => ({ ...DEVICE_GRADE_PRINCIPAL, user: asUserId(user) })
  const deltaJob = (user: string) => ({
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
        createdAt: 't0',
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
        ts: 't0',
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
              ts: 't0',
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
      client = new SyncWorkerClient({ dbPath: path })
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
