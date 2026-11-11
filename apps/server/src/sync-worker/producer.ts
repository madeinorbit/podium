import { setImmediate as yieldLoop } from 'node:timers/promises'
import { createLogger } from '@podium/logger'
import {
  CLIENT_WIRE_VERSION,
  SYNC_BATCH_MAX_ROWS,
  SYNC_BATCH_TARGET_BYTES,
  SYNC_LINE_MAX_BYTES,
  type SyncComplete,
  wireSchemaDigest,
} from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import {
  ChangeRangeBootstrapRequired,
  DEFAULT_RESCOPE_THRESHOLD,
  scopeChangesRange,
  shapedValue,
} from '@podium/sync/bootstrap-worker'
import { perfPrincipal } from '../modules/perf/principal'
import { perf } from '../modules/perf/registry'
import { pipeSyncBody } from '../sync/pipe-sync-body'
import { type BootstrapMetrics, type SyncJob, type SyncMetaSummary, SyncWorkerError } from './types'
import { type BootstrapVisibilityOptions, bootstrapVisibility } from './visibility'

const log = createLogger('server:sync-bootstrap')
const utf8 = new TextEncoder()
/**
 * One read-only WAL connection per active job in the one worker. Holding the reader
 * for a transfer prevents checkpointing past its snapshot until completion/cancel;
 * the ten-minute admission deadline bounds this window (and consequent WAL growth).
 */
async function* produceRecords(
  dbPath: string,
  job: SyncJob,
  signal: AbortSignal,
  onMeta: (meta: SyncMetaSummary) => void,
  onMetrics?: (metrics: BootstrapMetrics) => void,
  options: BootstrapVisibilityOptions = {},
): AsyncGenerator<Uint8Array> {
  const started = performance.now()
  const attribution = perfPrincipal(job.principal)
  const phases: BootstrapMetrics['phases'] = {}
  const heapBefore = process.memoryUsage().heapUsed
  let heapAfterPrefetch = heapBefore,
    peakProcessRss = process.memoryUsage().rss,
    refCount = 0
  const sampleMemory = () => {
    peakProcessRss = Math.max(peakProcessRss, process.memoryUsage().rss)
  }
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
  const db = openDatabase(dbPath, { readOnly: true })
  let bundle: Awaited<ReturnType<typeof bootstrapVisibility>> | undefined
  let transaction = false
  let rows = 0,
    records = 0,
    bytesBefore = 0,
    bytesAfter = 0
  let outcome = 'producer-failed'
  const line = (record: unknown) => {
    const t = performance.now()
    const bytes = utf8.encode(JSON.stringify(record) + '\n')
    phase('encode', t, bytes.byteLength)
    if (bytes.byteLength - 1 > SYNC_LINE_MAX_BYTES) throw new SyncWorkerError('row-too-large')
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
    const seq =
      (
        db.prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'").get() as
          | { seq: number }
          | undefined
      )?.seq ?? 0
    const minAvailableSeq =
      (db.prepare('SELECT min(seq) AS seq FROM changes').get() as { seq: number | null }).seq ??
      seq + 1
    phase('capture', capture)
    if ('mode' in job && job.mode === 'delta') {
      const target = job.to ?? seq
      if (job.from > seq || target > seq) throw new SyncWorkerError('future-cursor')
      if (minAvailableSeq > job.from + 1) throw new SyncWorkerError('compacted-or-unknown')
      bundle = bootstrapVisibility(db, options)
      const { policy, anchors, sync } = await bundle.context
      const iterator = scopeChangesRange(
        sync,
        { policy, anchors, rescopeThreshold: DEFAULT_RESCOPE_THRESHOLD },
        job.principal,
        job.from,
        target,
        job.pageRows ?? 500,
      )[Symbol.asyncIterator]()
      try {
        let next = await iterator.next()
        if (!next.done && next.value.kind === 'rescope') throw new SyncWorkerError('rescope')
        const meta: SyncMetaSummary = {
          type: 'syncMeta',
          formatVersion: 1,
          mode: 'delta',
          wireVersion: CLIENT_WIRE_VERSION,
          wireSchemaDigest: wireSchemaDigest(),
          transferId: job.transferId,
          feedId: job.feedId,
          epoch: job.epoch,
          seq: target,
          fromSeq: job.from,
          minAvailableSeq,
        }
        const bytes = line(meta)
        onMeta(meta)
        yield bytes
        while (!next.done) {
          check()
          const delivery = next.value
          if (delivery.kind === 'rescope') {
            outcome = 'authorization-changed'
            yield line({
              type: 'syncError',
              transferId: job.transferId,
              reason: 'authorization-changed',
            })
            return
          }
          rows += delivery.changes.length
          yield line({
            type: 'feedDelta',
            feedId: job.feedId,
            epoch: job.epoch,
            fromSeq: delivery.fromSeq,
            seq: delivery.throughSeq,
            minAvailableSeq,
            changes: delivery.changes,
          })
          await yieldLoop()
          check()
          try {
            next = await iterator.next()
          } catch {
            outcome = 'read-failed'
            yield line({ type: 'syncError', transferId: job.transferId, reason: 'read-failed' })
            return
          }
        }
        yield line({
          type: 'syncComplete',
          transferId: job.transferId,
          seq: target,
          records: records - 1,
          rows,
        } satisfies SyncComplete)
        outcome = 'complete'
        return
      } finally {
        await iterator.return?.()
      }
    }
    // Stream the model tables a page at a time inside the snapshot fixed by
    // the head read (design POD-6253 §4). Every row carries that head number.
    bundle = bootstrapVisibility(db, options)
    const { policy: world, records: source } = await bundle.context
    check()
    const meta: SyncMetaSummary = {
      type: 'syncMeta',
      formatVersion: 1,
      mode: 'snapshot',
      wireVersion: CLIENT_WIRE_VERSION,
      wireSchemaDigest: wireSchemaDigest(),
      transferId: job.transferId,
      feedId: job.feedId,
      epoch: job.epoch,
      seq,
      minAvailableSeq,
      // No `totalRows`: the count is known only once every table is read, and
      // the load streams in one pass.
    }
    const metaBytes = line(meta)
    // Copy fields from the serialized first line, never a second world read.
    onMeta(JSON.parse(new TextDecoder().decode(metaBytes)) as SyncMetaSummary)
    yield metaBytes
    const range = { feedId: job.feedId, epoch: job.epoch, fromSeq: 0, seq, minAvailableSeq }
    let batch: unknown[] = [],
      batchBytes = 0
    const frame = (changes: unknown[], last: boolean) => ({
      type: 'feedBootstrap',
      ...range,
      changes,
      last,
      // The total, once it is known: on the last chunk.
      ...(last ? { totalRows: rows } : {}),
    })
    const batchOverhead = utf8.encode(JSON.stringify(frame([], false)) + '\n').byteLength
    const pages = source.streamAllKinds()[Symbol.asyncIterator]()
    try {
      for (;;) {
        const build = performance.now()
        const next = await pages.next()
        phase('build', build)
        if (next.done) break
        const { entity, records: page } = next.value
        refCount += page.length
        check()
        // The sharing rules' facts for exactly this page's records.
        const prepare = performance.now()
        const policy = await world.forBootstrap(
          page.map((record) => ({ entity, entityId: record.id })),
        )
        phase('visibility', prepare)
        check()
        for (const record of page) {
          const ref = { entity, entityId: record.id }
          if (!policy.decide(job.principal, ref).visible) continue
          const change = {
            seq,
            entity,
            entityId: record.id,
            op: 'upsert',
            // The row as this principal may receive it (design §4.2, POD-6288).
            value: shapedValue(policy, job.principal, ref, record.value),
          }
          const size = utf8.encode(JSON.stringify(change)).byteLength
          if (utf8.encode(JSON.stringify(frame([change], false))).byteLength > SYNC_LINE_MAX_BYTES)
            throw new SyncWorkerError('row-too-large')
          if (
            batch.length &&
            (batch.length >= SYNC_BATCH_MAX_ROWS ||
              batchOverhead + batchBytes + size + batch.length > SYNC_BATCH_TARGET_BYTES)
          ) {
            yield line(frame(batch, false))
            batch = []
            batchBytes = 0
            await yieldLoop()
            check()
          }
          batch.push(change)
          batchBytes += size
          rows++
        }
        await yieldLoop()
        check()
      }
    } finally {
      await pages.return?.()
    }
    heapAfterPrefetch = process.memoryUsage().heapUsed
    yield line(frame(batch, true))
    check()
    yield line({
      type: 'syncComplete',
      transferId: job.transferId,
      seq,
      records: records - 1,
      rows,
    } satisfies SyncComplete)
    outcome = 'complete'
  } catch (error) {
    const reason =
      error instanceof SyncWorkerError || error instanceof ChangeRangeBootstrapRequired
        ? error.reason
        : signal.aborted
          ? 'cancelled'
          : 'producer-failed'
    outcome = reason
    if (reason === 'row-too-large') {
      yield line({ type: 'syncError', transferId: job.transferId, reason })
      return // Let the content encoder finish its trailer before reporting the typed failure.
    }
    throw error instanceof SyncWorkerError ? error : new SyncWorkerError(reason)
  } finally {
    try {
      if (transaction) db.exec('ROLLBACK')
    } finally {
      if (bundle) await bundle.executor.close()
      else db.close()
    }
    phases.compress = { ms: 0, bytes: bytesAfter }
    perf.record('phase', 'syncBootstrap.compress', 0, attribution, bytesAfter)
    phase('transfer', started, bytesAfter)
    onMetrics?.({
      transferId: job.transferId,
      phases,
      rows,
      refs: refCount,
      records,
      bytesBefore,
      bytesAfter,
      queueWaitMs: 0,
      outcome,
      peakProcessRss,
      heapBefore,
      heapAfterPrefetch,
    })
  }
}

/** The entire content-coding pipeline stays in this worker, including codec flushing. */
export async function* produceBootstrap(
  dbPath: string,
  job: SyncJob,
  signal: AbortSignal,
  onMeta: (meta: SyncMetaSummary) => void,
  onMetrics?: (metrics: BootstrapMetrics) => void,
  options: BootstrapVisibilityOptions = {},
): AsyncGenerator<Uint8Array> {
  const lifetime = new AbortController()
  const abort = () => lifetime.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const telemetry: { metrics?: BootstrapMetrics } = {}
  const records = produceRecords(
    dbPath,
    job,
    lifetime.signal,
    onMeta,
    (value) => {
      telemetry.metrics = value
    },
    options,
  )
  const source = {
    [Symbol.asyncIterator]: () => records,
    abort: (reason: unknown) => lifetime.abort(reason),
  }
  const started = performance.now()
  const reader = pipeSyncBody(source, job.encoding, lifetime.signal).getReader()
  let bytesAfter = 0,
    finished = false,
    outcome = 'complete'
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        finished = true
        break
      }
      bytesAfter += next.value.byteLength
      yield next.value
    }
    if (telemetry.metrics?.outcome === 'row-too-large') throw new SyncWorkerError('row-too-large')
  } catch (error) {
    const failure =
      error instanceof SyncWorkerError
        ? error
        : new SyncWorkerError(signal.aborted ? 'cancelled' : 'producer-failed')
    outcome = failure.reason
    throw failure
  } finally {
    signal.removeEventListener('abort', abort)
    if (!finished) {
      lifetime.abort(new SyncWorkerError('cancelled'))
      await reader.cancel(lifetime.signal.reason).catch(() => {})
    }
    // pipeSyncBody requests return on abort; await it here before releasing the
    // worker's job slot so no replacement job can overlap an unclosed reader.
    await records.return(undefined).catch(() => {})
    reader.releaseLock()
    const metrics = telemetry.metrics
    if (metrics) {
      metrics.outcome =
        !finished && outcome === 'complete'
          ? lifetime.signal.reason instanceof SyncWorkerError
            ? lifetime.signal.reason.reason
            : 'cancelled'
          : finished
            ? metrics.outcome
            : outcome
      metrics.bytesAfter = bytesAfter
      // Wall time of the streaming coding pipeline, including its backpressure.
      metrics.phases.compress = {
        ms: job.encoding === 'identity' ? 0 : performance.now() - started,
        bytes: bytesAfter,
      }
      metrics.phases.transfer = { ms: performance.now() - started, bytes: bytesAfter }
      onMetrics?.(metrics)
      log.info('bootstrap finished', {
        transferId: job.transferId,
        rows: metrics.rows,
        records: metrics.records,
        bytesBefore: metrics.bytesBefore,
        bytesAfter,
        outcome: metrics.outcome,
      })
    }
  }
}
