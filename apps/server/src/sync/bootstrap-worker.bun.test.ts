import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { asIssueId, asMachineId, asUserId } from '@podium/model'
import { Hono } from 'hono'
import WebSocket from 'ws'

const { Authority, DEVICE_GRADE_PRINCIPAL, GrantEdgeVisibilityPolicy, NoDelegationsGranted } =
  await import('@podium/sync')
const { makeFeedVisibility } = await import('../feed-visibility')
const { WorldIndex } = await import('../modules/world-index')
const { openTestStore } = await import('../test-support/open-test-store')
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
  design: null,
  acceptance: null,
  notes: null,
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
  const world = await WorldIndex.load(store)
  const forbidden = (): never => {
    throw new Error('bootstrap read an anchor')
  }
  const feed = makeFeedVisibility({
    store,
    worldIndex: world.reader,
    audienceResourceIds: forbidden,
    audienceFor: forbidden,
    issueEventSubjects: forbidden,
    authorizationRevision: forbidden,
  })
  const authority = new Authority({
    store: store.sync,
    now: () => 1,
    transact: (fn) => store.transact(fn),
    visibility: new GrantEdgeVisibilityPolicy(feed.state, new NoDelegationsGranted()),
    anchors: feed.anchors,
  })
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
    store,
    worker,
    authority,
    async close() {
      await worker.close()
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

it.each([
  'identity',
  'gzip',
  'zstd',
])('real HTTP worker %s rows equal Authority.bootstrap and certify the fixture head', async (coding) => {
  const f = await fixture()
  try {
    await f.store.issues.upsertIssue(issue('invisible'))
    await f.store.sync.appendChanges(
      [
        {
          entity: 'repo',
          entityId: '/visible',
          op: 'upsert',
          payload: JSON.stringify({ id: '/visible', title: 'visible' }),
        },
        {
          entity: 'issue',
          entityId: 'invisible',
          op: 'upsert',
          payload: JSON.stringify({ id: 'invisible' }),
        },
      ],
      1,
    )
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
      seq: head,
      feedId: 'fixture-feed',
      epoch: 'fixture-epoch',
    })
    expect(records.at(-1)).toMatchObject({ type: 'syncComplete', seq: head })
    expect(records.filter((r) => r.type === 'feedBootstrap').flatMap((r) => r.changes)).toEqual(
      expected.changes,
    )
    expect(expected.changes.map((row) => row.entityId)).toEqual(['/visible'])
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
    await f.store.sync.appendChanges(
      [
        {
          entity: 'repo',
          entityId: '/r',
          op: 'upsert',
          payload: JSON.stringify({ text: 'x'.repeat(1024 * 1024) }),
        },
      ],
      1,
    )
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
    const payload = JSON.stringify({ text: 'x'.repeat(10 * 1024) })
    for (let start = 0; start < 5120; start += 128) {
      await f.store.sync.appendChanges(
        Array.from({ length: 128 }, (_, offset) => ({
          entity: 'repo' as const,
          entityId: `repo-${start + offset}`,
          op: 'upsert' as const,
          payload,
        })),
        1,
      )
    }
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
      fixturePayloadBytes: payload.length * 5120,
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
