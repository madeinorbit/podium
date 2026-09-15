import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync/bootstrap-worker'
import { applyBaselineSchema } from '../migrations'
import type { BootstrapJob } from './types'
import { SyncWorkerClient } from './worker-client'

const job = (id: string, deadlineMs?: number): BootstrapJob => ({
  transferId: id,
  principal: DEVICE_GRADE_PRINCIPAL,
  feedId: 'feed',
  epoch: 'epoch',
  encoding: 'identity',
  ...(deadlineMs ? { deadlineMs } : {}),
})
async function fixture(options: { monitorMs?: number; wedgedMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-worker-'))
  const path = join(dir, 'test.db')
  const writer = openDatabase(path)
  applyBaselineSchema(writer)
  writer.exec('PRAGMA journal_mode=WAL')
  const client = new SyncWorkerClient({ dbPath: path, ...options })
  return {
    path,
    writer,
    client,
    async close() {
      await client.close()
      writer.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
function append(writer: SqlDatabase, id: string, text = 'x') {
  const payload = JSON.stringify({ id, text })
  writer.exec('BEGIN IMMEDIATE')
  try {
    writer
      .prepare(
        "INSERT INTO changes(entity,entity_id,op,payload,event_time) VALUES ('repo',?,'upsert',?,1)",
      )
      .run(id, payload)
    writer
      .prepare(
        "INSERT OR REPLACE INTO change_latest(entity,entity_id,seq,payload) VALUES ('repo',?,last_insert_rowid(),?)",
      )
      .run(id, payload)
    writer.exec('COMMIT')
  } catch (error) {
    writer.exec('ROLLBACK')
    throw error
  }
}
async function checkpoint(writer: SqlDatabase) {
  for (let i = 0; i < 100; i++) {
    const row = writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
    if (row.busy === 0) return
    await delay(10)
  }
  throw new Error('read transaction was not released')
}
async function text(body: ReadableStream<Uint8Array>) {
  return await new Response(body).text()
}

describe('real sync worker boundary', () => {
  it.each([
    'gzip',
    'zstd',
  ] as const)('produces complete %s bytes in the worker', async (encoding) => {
    const f = await fixture()
    try {
      for (let i = 0; i < 300; i++) append(f.writer, String(i), 'x'.repeat(4096))
      const transfer = f.client.bootstrap({ ...job(encoding), encoding })
      const encoded = Buffer.from(await new Response(transfer.body).arrayBuffer())
      const decoded = (
        encoding === 'gzip' ? gunzipSync(encoded) : zstdDecompressSync(encoded)
      ).toString()
      const lines = decoded
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(lines[0]).toEqual(await transfer.meta)
      expect(lines.at(-1)).toMatchObject({ type: 'syncComplete', rows: 300 })
      expect(
        lines.filter((row) => row.type === 'feedBootstrap').flatMap((row) => row.changes),
      ).toHaveLength(300)
      expect(encoded.byteLength).toBeLessThan(decoded.length / 10)
      await checkpoint(f.writer)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('replaces an active worker whose progress stalls despite a live heartbeat', async () => {
    const f = await fixture({ monitorMs: 10 })
    try {
      append(f.writer, 'one')
      const transfer = f.client.bootstrap(job('wedged'))
      await transfer.meta
      // Advance only the progress-age seam; a heartbeat timeout cannot explain
      // this replacement. No reader credit is supplied while the monitor runs.
      ;(f.client as unknown as { lastProgress: number }).lastProgress = 0
      for (let i = 0; i < 100 && f.client.activeJobCount() !== 0; i++) await delay(10)
      expect(f.client.activeJobCount()).toBe(0)
      await expect(text(transfer.body)).rejects.toMatchObject({ reason: 'worker-crashed' })
      await checkpoint(f.writer)
    } finally {
      await f.close()
    }
  }, 30_000)
  it('holds a consistent head and complete row set during concurrent appends', async () => {
    const f = await fixture()
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      for (let i = 0; i < 600; i++) append(f.writer, String(i), 'x'.repeat(1024))
      const transfer = f.client.bootstrap(job('consistent'))
      // This writer only appends new refs, so seq <= S is an independent exact oracle.
      let next = 600
      timer = setInterval(() => append(f.writer, String(next++)), 1)
      const meta = await transfer.meta
      const output = (await text(transfer.body))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      clearInterval(timer)
      timer = undefined
      const actual = output.filter((r) => r.type === 'feedBootstrap').flatMap((r) => r.changes)
      const expected = f.writer
        .prepare('SELECT seq,entity_id FROM change_latest WHERE seq <= ? ORDER BY seq')
        .all(meta.seq) as { seq: number; entity_id: string }[]
      expect(actual.map((r) => [r.seq, r.entityId])).toEqual(
        expected.map((r) => [r.seq, r.entity_id]),
      )
      expect(actual.every((r) => r.seq <= meta.seq)).toBe(true)
      expect(output.at(-1).seq).toBe(meta.seq)
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
    } finally {
      clearInterval(timer)
      await f.close()
    }
  }, 30_000)
  it('aborts mid-pass-2 and expires a stalled transfer, releasing both snapshots', async () => {
    const f = await fixture()
    try {
      for (let i = 0; i < 300; i++) append(f.writer, String(i), 'x'.repeat(4096))
      const abort = new AbortController()
      const first = f.client.bootstrap(job('abort'), abort.signal)
      const reader = first.body.getReader()
      await reader.read()
      await reader.read()
      append(f.writer, 'after-capture')
      expect(
        (f.writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy,
      ).toBe(1)
      abort.abort()
      expect(await reader.read()).toEqual({ done: true, value: undefined })
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
      const expiring = f.client.bootstrap(job('after-abort'))
      await expiring.meta
      expect(await text(expiring.body)).toContain('syncComplete')
      const stalled = f.client.bootstrap(job('stalled', Date.now() + 100))
      await expect(textAfterDeadline(stalled.body)).rejects.toMatchObject({ reason: 'deadline' })
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
    } finally {
      await f.close()
    }
  }, 30_000)
  it('bounds admission and fails every transfer on worker termination and shutdown', async () => {
    const f = await fixture()
    try {
      append(f.writer, 'one')
      const transfers = Array.from({ length: 11 }, (_, i) => f.client.bootstrap(job(String(i))))
      await expect(transfers[10]!.meta).rejects.toMatchObject({ reason: 'queue-full' })
      for (const t of transfers) void t.body.cancel().catch(() => {})
      await checkpoint(f.writer)
      const crashed = f.client.bootstrap(job('crash'))
      await crashed.meta
      // Actual worker termination, not a synthetic client error.
      const worker = (f.client as unknown as { worker: { terminate(): Promise<number> } }).worker
      await worker.terminate()
      await expect(text(crashed.body)).rejects.toMatchObject({ reason: 'worker-crashed' })
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
      for (let i = 0; i < 100 && f.client.state() !== 'running'; i++) await delay(20)
      expect(f.client.state()).toBe('running')
      const stopped = f.client.bootstrap(job('shutdown'))
      await stopped.meta
      await f.client.close()
      await expect(text(stopped.body)).rejects.toMatchObject({ reason: 'shutdown' })
      expect(f.client.activeJobCount()).toBe(0)
      await checkpoint(f.writer)
    } finally {
      await f.close()
    }
  }, 30_000)
})
async function textAfterDeadline(body: ReadableStream<Uint8Array>) {
  await delay(200)
  return text(body)
}

// A separate Bun host leaves abandoned consumer promises genuinely unhandled,
// without changing the test runner's own rejection policy.
it.each([
  'abort-first',
  'cancel-first',
  'abort-first-native',
  'cancel-first-native',
])('cancel ordering %s leaves no abandoned rejection', async (ordering) => {
  const f = await fixture()
  try {
    const source = `
      import { SyncWorkerClient } from ${JSON.stringify(new URL('./worker-client.ts', import.meta.url).pathname)};
      const client = new SyncWorkerClient({ dbPath: ${JSON.stringify(f.path)} });
      const abort = new AbortController();
      const transfer = client.bootstrap(${JSON.stringify(job('ordering'))}, abort.signal);
      await transfer.meta;
      const reader = transfer.body.getReader();
      const pendingRead = reader.read();
      let cancellation;
      if (!${JSON.stringify(ordering)}.endsWith('-native')) process.on('unhandledRejection', (error, promise) => {
        console.error('UNHANDLED', promise === pendingRead ? 'reader.read()' : promise === cancellation ? 'reader.cancel()' : promise === transfer.meta ? 'meta' : 'unknown', error.reason);
        process.exitCode = 1;
      });
      if (${JSON.stringify(ordering)}.startsWith('abort-first')) {
        abort.abort();
        cancellation = reader.cancel();
      } else {
        cancellation = reader.cancel();
        abort.abort();
      }
      const completion = await transfer.completed;
      if (completion.reason !== 'cancelled' || client.activeJobCount() !== 0) throw new Error('cancellation did not release worker job');
      const next = client.bootstrap(${JSON.stringify(job('after-cancel'))});
      if (!(await new Response(next.body).text()).includes('syncComplete')) throw new Error('replacement admission failed');
      await client.close();
      await new Promise(resolve => setTimeout(resolve, 20));
    `
    const child = Bun.spawn([process.execPath, '--conditions=@podium/source', '--eval', source], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  } finally {
    await f.close()
  }
}, 30_000)

it.each(['identity', 'gzip', 'zstd'] as const)('pins delta rows and floor to its snapshot with %s', async encoding => {
  const f = await fixture()
  try {
    for (let i = 0; i < 100; i++) append(f.writer, `delta-${i}`, 'x'.repeat(4096))
    const transfer = f.client.delta({ ...job('delta-snapshot', Date.now() + 10_000), mode: 'delta', from: 0, pageRows: 10, encoding })
    expect(await transfer.meta).toMatchObject({ mode: 'delta', fromSeq: 0, seq: 100, minAvailableSeq: 1 })
    append(f.writer, 'later')
    f.writer.exec('DELETE FROM changes WHERE seq < 50')
    let bytes = Buffer.from(await new Response(transfer.body).arrayBuffer())
    if (encoding === 'gzip') bytes = gunzipSync(bytes)
    if (encoding === 'zstd') bytes = zstdDecompressSync(bytes)
    const lines = bytes.toString().trim().split('\n').map(line => JSON.parse(line))
    const pages = lines.filter(line => line.type === 'feedDelta')
    expect(pages.flatMap(page => page.changes).length).toBe(100)
    expect(pages.every(page => page.minAvailableSeq === 1)).toBe(true)
    expect(lines.at(-1)).toMatchObject({ type: 'syncComplete', seq: 100, rows: 100, records: 10 })
    await transfer.completed
    await checkpoint(f.writer)
    const refused = f.client.delta({ ...job('delta-compacted', Date.now() + 10_000), mode: 'delta', from: 0 })
    // Settle through the normal event loop before Bun's matcher inspects the error.
    expect(await refused.meta.then(() => undefined, error => error)).toMatchObject({ reason: 'compacted-or-unknown' })
    await refused.completed
    const future = f.client.delta({ ...job('delta-future', Date.now() + 10_000), mode: 'delta', from: 200 })
    expect(await future.meta.then(() => undefined, error => error)).toMatchObject({ reason: 'future-cursor' })
    await future.completed
    const empty = f.client.delta({ ...job('delta-empty', Date.now() + 10_000), mode: 'delta', from: 101 })
    const emptyRows = (await text(empty.body)).trim().split('\n').map(line => JSON.parse(line))
    expect(emptyRows[1]).toMatchObject({ type: 'feedDelta', fromSeq: 101, seq: 101, changes: [] })
    await empty.completed
  } finally { await f.close() }
}, 30_000)
