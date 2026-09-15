import { setImmediate as yieldLoop } from 'node:timers/promises'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { WIRE_VERSION, wireSchemaDigest, SYNC_BATCH_TARGET_BYTES, SYNC_BATCH_MAX_ROWS, SYNC_LINE_MAX_BYTES, type SyncComplete } from '@podium/protocol'
import type { EntityRef } from '@podium/sync'
import { createLogger } from '@podium/logger'
import { perf } from '../modules/perf/registry'
import { perfPrincipal } from '../modules/perf/principal'
import { bootstrapVisibility } from './visibility'
import { SyncWorkerError, type BootstrapJob, type SyncMetaSummary, type BootstrapMetrics } from './types'

const log = createLogger('server:sync-bootstrap')
const utf8 = new TextEncoder()
interface RefRow { seq: number; entity: EntityRef['entity']; entity_id: string }
interface PayloadRow extends RefRow { payload: string }
const key = (ref: EntityRef) => JSON.stringify([ref.entity, ref.entityId])
function* iterate<T>(db: SqlDatabase, sql: string): Generator<T> {
  const statement = db.prepare(sql)
  if (!statement.iterate) throw new Error('SQLite streaming iteration unavailable')
  yield* statement.iterate() as IterableIterator<T>
}

/**
 * One read-only WAL connection per active job in the one worker. Holding the reader
 * for a transfer prevents checkpointing past its snapshot until completion/cancel;
 * the ten-minute admission deadline bounds this window (and consequent WAL growth).
 */
export async function* produceBootstrap(
  dbPath: string,
  job: BootstrapJob,
  signal: AbortSignal,
  onMeta: (meta: SyncMetaSummary) => void,
  onMetrics?: (metrics: BootstrapMetrics) => void,
): AsyncGenerator<Uint8Array> {
  const started = performance.now()
  const attribution = perfPrincipal(job.principal)
  const phases: BootstrapMetrics['phases'] = {}
  const heapBefore = process.memoryUsage().heapUsed
  let heapAfterPrefetch = heapBefore, peakProcessRss = process.memoryUsage().rss, refCount = 0
  const sampleMemory = () => { peakProcessRss = Math.max(peakProcessRss, process.memoryUsage().rss) }
  const phase = (name: string, start: number, bytes = 0) => {
    const ms = performance.now() - start
    const prior = phases[name] ?? { ms: 0, bytes: 0 }
    phases[name] = { ms: prior.ms + ms, bytes: prior.bytes + bytes }
    perf.record('phase', `syncBootstrap.${name}`, ms, attribution, bytes)
    sampleMemory()
  }
  const check = () => {
    if (signal.aborted) throw signal.reason
    if (Date.now() >= (job.deadlineMs ?? Infinity)) throw new SyncWorkerError('deadline')
  }
  check()
  // TODO(A4): run these identity bytes through the shared streaming content encoder.
  if (job.encoding !== 'identity') throw new SyncWorkerError('unavailable')
  const db = openDatabase(dbPath, { readOnly: true })
  let bundle: Awaited<ReturnType<typeof bootstrapVisibility>> | undefined
  let transaction = false
  let rows = 0, records = 0, bytesBefore = 0, bytesAfter = 0
  let outcome = 'producer-failed'
  const line = (record: unknown) => {
    const t = performance.now()
    const bytes = utf8.encode(JSON.stringify(record) + '\n')
    phase('encode', t, bytes.byteLength)
    if (bytes.byteLength > SYNC_LINE_MAX_BYTES) throw new SyncWorkerError('row-too-large')
    bytesBefore += bytes.byteLength
    bytesAfter += bytes.byteLength
    records++
    return bytes
  }
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN')
    transaction = true
    const capture = performance.now()
    // This FIRST read fixes the SQLite snapshot; every visibility read shares it.
    const seq = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'").get() as {seq:number} | undefined)?.seq ?? 0
    const minAvailableSeq = (db.prepare('SELECT min(seq) AS seq FROM changes').get() as {seq:number | null}).seq ?? seq + 1
    phase('capture', capture)
    const pass1 = performance.now()
    const refs: EntityRef[] = []
    for (const row of iterate<RefRow>(db, 'SELECT seq, entity, entity_id FROM change_latest ORDER BY seq')) {
      refs.push({ entity: row.entity, entityId: row.entity_id })
      if (refs.length % 256 === 0) { await yieldLoop(); check() }
    }
    bundle = await bootstrapVisibility(db)
    const policy = await bundle.policy.forBootstrap(refs)
    check()
    const visible = new Set<string>()
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!
      if (policy.decide(job.principal, ref).visible) visible.add(key(ref))
      if (i % 256 === 0) { await yieldLoop(); check() }
    }
    refCount = refs.length
    heapAfterPrefetch = process.memoryUsage().heapUsed
    const totalRows = visible.size
    phase('pass1', pass1)
    const meta: SyncMetaSummary = { type: 'syncMeta', formatVersion: 1, mode: 'snapshot', wireVersion: WIRE_VERSION, wireSchemaDigest: wireSchemaDigest(), transferId: job.transferId, feedId: job.feedId, epoch: job.epoch, seq, minAvailableSeq, totalRows }
    const metaBytes = line(meta)
    // Copy fields from the serialized first line, never a second world read.
    onMeta(JSON.parse(new TextDecoder().decode(metaBytes)) as SyncMetaSummary)
    yield metaBytes
    const range = { feedId: job.feedId, epoch: job.epoch, fromSeq: 0, seq, minAvailableSeq }
    const pass2 = performance.now()
    let batch: unknown[] = [], batchBytes = 0
    const frame = (changes: unknown[], last: boolean) => ({ type: 'feedBootstrap', ...range, changes, last, totalRows })
    const batchOverhead = utf8.encode(JSON.stringify(frame([], false)) + '\n').byteLength
    for (const row of iterate<PayloadRow>(db, 'SELECT seq, entity, entity_id, payload FROM change_latest ORDER BY seq')) {
      check()
      if (!visible.has(key({ entity: row.entity, entityId: row.entity_id }))) continue
      const change = { seq: row.seq, entity: row.entity, entityId: row.entity_id, op: 'upsert', value: JSON.parse(row.payload) }
      const size = utf8.encode(JSON.stringify(change)).byteLength
      if (utf8.encode(JSON.stringify(frame([change], false)) + '\n').byteLength > SYNC_LINE_MAX_BYTES) throw new SyncWorkerError('row-too-large')
      if (batch.length && (batch.length >= SYNC_BATCH_MAX_ROWS || batchOverhead + batchBytes + size + batch.length > SYNC_BATCH_TARGET_BYTES)) {
        yield line(frame(batch, false)); batch = []; batchBytes = 0
        await yieldLoop(); check()
      }
      batch.push(change); batchBytes += size; rows++
    }
    yield line(frame(batch, true))
    phase('pass2', pass2)
    check()
    yield line({ type: 'syncComplete', transferId: job.transferId, seq, records: records - 1, rows } satisfies SyncComplete)
    outcome = 'complete'
  } catch (error) {
    const reason = error instanceof SyncWorkerError ? error.reason : signal.aborted ? 'cancelled' : 'producer-failed'
    outcome = reason
    if (reason === 'row-too-large') yield line({ type: 'syncError', transferId: job.transferId, reason })
    throw error instanceof SyncWorkerError ? error : new SyncWorkerError(reason)
  } finally {
    try { if (transaction) db.exec('ROLLBACK') }
    finally { if (bundle) await bundle.executor.close(); else db.close() }
    phases.compress = { ms: 0, bytes: bytesAfter }
    perf.record('phase', 'syncBootstrap.compress', 0, attribution, bytesAfter)
    phase('transfer', started, bytesAfter)
    onMetrics?.({ transferId: job.transferId, phases, rows, refs: refCount, records, bytesBefore, bytesAfter, queueWaitMs: 0, outcome, peakProcessRss, heapBefore, heapAfterPrefetch })
    log.info('bootstrap finished', { transferId: job.transferId, rows, records, bytesBefore, bytesAfter, outcome })
  }
}
