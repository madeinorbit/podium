import { addSink, type LogRecord, resetLogging } from '@podium/logger'
import { WIRE_VERSION } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSyncTransferTelemetry,
  HttpBootstrapSource,
  HttpDeltaSource,
  SyncAuthExpiredError,
  type SyncTransferTelemetry,
} from './index'

const encoder = new TextEncoder()
const NS = 'client-core:sync-transfer'
const feed = { feedId: 'feed-1', epoch: 'epoch-1' }
const SNAPSHOT_SEQ = 1000
const TRANSFER_ID = 'srv-transfer'

/** A well-formed snapshot of `records` records carrying `rowsPer` rows each. */
function snapshot(records: number, rowsPer: number): unknown[] {
  const lines: unknown[] = [{
    type: 'syncMeta', formatVersion: 1, mode: 'snapshot', transferId: TRANSFER_ID, ...feed,
    seq: SNAPSHOT_SEQ, minAvailableSeq: 0, wireVersion: WIRE_VERSION,
    wireSchemaDigest: '0123456789abcdef', totalRows: records * rowsPer,
  }]
  for (let i = 0; i < records; i += 1) {
    lines.push({
      type: 'feedBootstrap', ...feed, fromSeq: 0, seq: SNAPSHOT_SEQ, minAvailableSeq: 0,
      last: i === records - 1,
      changes: Array.from({ length: rowsPer }, (_, j) => ({
        seq: j + 1, entity: 'future-kind', entityId: `${i}-${j}`, op: 'upsert', value: { title: 'x' },
      })),
    })
  }
  lines.push({ type: 'syncComplete', transferId: TRANSFER_ID, seq: SNAPSHOT_SEQ, records, rows: records * rowsPer })
  return lines
}

function deltaRange(from: number, to: number): unknown[] {
  return [
    { type: 'syncMeta', formatVersion: 1, mode: 'delta', transferId: TRANSFER_ID, ...feed,
      seq: to, fromSeq: from, minAvailableSeq: 0, wireVersion: WIRE_VERSION, wireSchemaDigest: '0123456789abcdef' },
    { type: 'feedDelta', ...feed, fromSeq: from, seq: to, minAvailableSeq: 0,
      changes: [{ seq: to, entity: 'future-kind', entityId: 'd', op: 'upsert', value: {} }] },
    { type: 'syncComplete', transferId: TRANSFER_ID, seq: to, records: 1, rows: 1 },
  ]
}

/** One transport read per line, so the read boundary is exercised repeatedly. */
function body(lines: unknown[]): ReadableStream<Uint8Array> {
  const parts = lines.map(value => encoder.encode(`${JSON.stringify(value)}\n`))
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === parts.length) controller.close()
      else controller.enqueue(parts[index++]!)
    },
  }, { highWaterMark: 0 })
}

function responseOf(
  lines: unknown[],
  init: { status?: number; encoding?: string; transferId?: string | null } = {},
): Response {
  const headers = new Headers({ 'content-type': 'application/x-ndjson' })
  if (init.encoding) headers.set('content-encoding', init.encoding)
  if (init.transferId !== null) headers.set('Podium-Transfer-Id', init.transferId ?? TRANSFER_ID)
  return new Response(body(lines), { status: init.status ?? 200, headers })
}

function harness(options: { progressRecords?: number } = {}) {
  const lines: LogRecord[] = []
  addSink({ name: 'capture', minLevel: 'trace', write: (record) => { lines.push(record) } })
  // One monotonic tick per reading, so every interval this file asserts on is
  // strictly positive and the arithmetic below is deterministic.
  let tick = 0
  const telemetry = createSyncTransferTelemetry({ ...options, now: () => (tick += 1) })
  return {
    telemetry,
    mine: (): LogRecord[] => lines.filter(record => record.ns === NS),
    of: (msg: string): LogRecord[] => lines.filter(record => record.ns === NS && record.msg === msg),
  }
}

function sources(telemetry: SyncTransferTelemetry | undefined, reply: () => Response) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => reply())
  const deps = {
    origin: 'https://example.test/',
    streamingFetch: { fetch, headers: () => ({ 'Accept-Encoding': 'gzip' }) },
    telemetry,
  }
  return { bootstrap: new HttpBootstrapSource(deps), delta: new HttpDeltaSource(deps), fetch }
}

async function drain(items: AsyncIterable<unknown>): Promise<number> {
  let count = 0
  for await (const _item of items) count += 1
  return count
}

/** What a superseded walk does: take one chunk and abandon the generator. */
async function abandonAfterFirst(items: AsyncIterable<unknown>): Promise<void> {
  for await (const _item of items) return
}

afterEach(() => {
  resetLogging()
})

describe('sync transfer telemetry (POD-4071)', () => {
  it('joins every client line to the server line on the transfer id, and logs nothing above debug', async () => {
    const h = harness()
    const { bootstrap } = sources(h.telemetry, () => responseOf(snapshot(3, 2)))

    await drain(bootstrap.bootstrap())

    const mine = h.mine()
    expect(mine.map(record => record.msg)).toEqual([
      'sync transfer started',
      'sync transfer opened',
      'sync transfer first record',
      'sync transfer finished',
    ])
    expect([...new Set(mine.map(record => record.level))]).toEqual(['debug'])
    // The started line CANNOT carry it — the response has not opened yet — and
    // saying so is the point: it is why the client mints an attempt id at all.
    expect(mine[0]?.transferId).toBeNull()
    expect(mine[0]?.attemptId).toBe('b1')
    expect(mine.slice(1).map(record => record.transferId)).toEqual(Array(3).fill(TRANSFER_ID))
    expect([...new Set(mine.map(record => record.attemptId))]).toEqual(['b1'])
  })

  it('names the replica cause that started the walk, and reads cold-start as first boot', async () => {
    const h = harness()
    const { bootstrap } = sources(h.telemetry, () => responseOf(snapshot(1, 1)))

    h.telemetry.noteReplicaEvent({ type: 'heal', rung: 2, cause: 'cold-start' })
    await drain(bootstrap.bootstrap())
    h.telemetry.noteReplicaEvent({ type: 'heal', rung: 4, cause: 'epoch-mismatch' })
    await drain(bootstrap.bootstrap())

    expect(h.of('sync transfer started').map(r => [r.cause, r.coldStart, r.attempt, r.attemptId])).toEqual([
      ['cold-start', true, 1, 'b1'],
      ['epoch-mismatch', false, 2, 'b2'],
    ])
  })

  it('parks a rung-1 gap against the delta it explains, never against a bootstrap', async () => {
    const h = harness()
    const { delta } = sources(h.telemetry, () => responseOf(deltaRange(5, 10)))

    h.telemetry.noteReplicaEvent({ type: 'heal', rung: 1, cause: 'gap' })
    const range = await delta.changesRange({ ...feed, seq: 5 })
    await drain(range as AsyncIterable<unknown>)

    const { bootstrap: cold } = sources(h.telemetry, () => responseOf(snapshot(1, 1)))
    await drain(cold.bootstrap())

    expect(h.of('sync transfer started').map(r => [r.mode, r.cause, r.coldStart, r.attemptId])).toEqual([
      ['delta', 'gap', null, 'd1'],
      // The gap was consumed by the delta; this bootstrap has no cause of its own.
      ['bootstrap', null, false, 'b1'],
    ])
  })

  it('states the status, the coding the server chose, and whether the body streams', async () => {
    const h = harness()
    const { bootstrap } = sources(h.telemetry, () => responseOf(snapshot(1, 1), { encoding: 'gzip' }))

    await drain(bootstrap.bootstrap())

    expect(h.of('sync transfer started')[0]).toMatchObject({ acceptEncoding: 'gzip', url: 'https://example.test/sync/bootstrap' })
    expect(h.of('sync transfer opened')[0]).toMatchObject({
      status: 200, contentEncoding: 'gzip', streaming: true, transferId: TRANSFER_ID,
    })
  })

  it('opens a line for a refusal too, so a rejected transfer is joinable as well', async () => {
    const h = harness()
    const { bootstrap } = sources(h.telemetry, () => responseOf([], { status: 401 }))

    await expect(drain(bootstrap.bootstrap())).rejects.toBeInstanceOf(SyncAuthExpiredError)

    expect(h.of('sync transfer opened')[0]).toMatchObject({ status: 401, transferId: TRANSFER_ID })
    expect(h.of('sync transfer finished')[0]).toMatchObject({
      outcome: 'failed', reason: 'SyncAuthExpiredError:http-401', transferId: TRANSFER_ID, records: 0,
    })
  })

  it('reports progress periodically — never per record, and never per row', async () => {
    const h = harness({ progressRecords: 3 })
    const { bootstrap } = sources(h.telemetry, () => responseOf(snapshot(9, 50)))

    await drain(bootstrap.bootstrap())

    const progress = h.of('sync transfer progress')
    expect(progress.length).toBeGreaterThan(0)
    // 9 records carrying 450 rows. Per-record would be >= 9 lines, per-row >= 450.
    expect(progress.length).toBeLessThan(9)
    expect(progress.map(record => record.records)).toEqual([4, 7])
    expect(progress.map(record => record.rows)).toEqual([200, 350])
    expect(h.of('sync transfer finished')[0]).toMatchObject({ records: 9, rows: 450, totalRows: 450 })
    // The terminal line answers to both names, so a reader joining the two
    // halves of one transfer never has to know which side called it which.
    const finished = h.of('sync transfer finished')[0]!
    expect(finished.totalMs).toBe(finished.elapsedMs)
  })

  it('splits the time across the seams that really exist, and times the commit outside the stream', async () => {
    const h = harness()
    const { bootstrap } = sources(h.telemetry, () => responseOf(snapshot(3, 2)))

    await drain(bootstrap.bootstrap())

    const finished = h.of('sync transfer finished')[0]!
    expect(finished.downloadMs as number).toBeGreaterThan(0)
    expect(finished.decodeMs as number).toBeGreaterThanOrEqual(0)
    expect(finished.stageMs as number).toBeGreaterThan(0)
    expect(finished.reads as number).toBeGreaterThan(0)
    expect(finished.decodedBytes as number).toBeGreaterThan(0)
    // The three phases partition the body's wall time; they cannot exceed it.
    const phases =
      (finished.downloadMs as number) + (finished.decodeMs as number) + (finished.stageMs as number)
    expect(phases).toBeLessThanOrEqual(finished.totalMs as number)

    // The install is not in the stream at all — it happens after the last chunk —
    // so it arrives through the Replica's own event and carries the same id.
    h.telemetry.noteReplicaEvent({
      type: 'bootstrap-installed', cause: 'cold-start', snapshotSeq: SNAPSHOT_SEQ,
      entityCount: 6, bufferedFramesApplied: 0,
    })
    const installed = h.of('sync bootstrap installed')[0]!
    expect(installed).toMatchObject({
      transferId: TRANSFER_ID, attemptId: 'b1', cause: 'cold-start', entityCount: 6,
    })
    expect(installed.commitMs as number).toBeGreaterThan(0)
    expect(installed.totalMs as number).toBeGreaterThan(installed.commitMs as number)
  })

  it('ends a superseded walk as cancelled, with the counts it had reached', async () => {
    const h = harness()
    const { bootstrap } = sources(h.telemetry, () => responseOf(snapshot(5, 2)))

    await abandonAfterFirst(bootstrap.bootstrap())

    expect(h.of('sync transfer finished')[0]).toMatchObject({
      outcome: 'cancelled', reason: null, transferId: TRANSFER_ID, records: 1, rows: 2,
    })
    // A cancelled stream is never followed by an install, so it must not be
    // credited with the next one's commit.
    h.telemetry.noteReplicaEvent({
      type: 'bootstrap-installed', cause: 'cold-start', snapshotSeq: SNAPSHOT_SEQ,
      entityCount: 0, bufferedFramesApplied: 0,
    })
    expect(h.of('sync bootstrap installed')[0]).toMatchObject({
      attemptId: null, transferId: null, commitMs: null, totalMs: null,
    })
  })

  it('reports a delta the authority refuses as bootstrap-required, not as a failure', async () => {
    const h = harness()
    const { delta } = sources(h.telemetry, () => new Response(
      encoder.encode(JSON.stringify({ kind: 'bootstrap-required', reason: 'compacted-or-unknown' })),
      { status: 409, headers: { 'Podium-Transfer-Id': TRANSFER_ID } },
    ))

    const range = await delta.changesRange({ ...feed, seq: 5 })

    expect(range).toEqual({ kind: 'bootstrap-required', reason: 'compacted-or-unknown' })
    expect(h.of('sync transfer finished')[0]).toMatchObject({
      mode: 'delta', outcome: 'bootstrap-required', reason: 'compacted-or-unknown', transferId: TRANSFER_ID,
    })
  })

  it('emits nothing at all when no telemetry is wired', async () => {
    const h = harness()
    const { bootstrap } = sources(undefined, () => responseOf(snapshot(2, 2)))

    expect(await drain(bootstrap.bootstrap())).toBe(3)

    expect(h.mine()).toEqual([])
  })
})
