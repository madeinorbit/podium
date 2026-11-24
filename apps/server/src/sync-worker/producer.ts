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
import {
  ChangeRangeBootstrapRequired,
  FEED_RESCOPE_THRESHOLD,
  scopeChangesRange,
} from '@podium/sync/bootstrap-worker'
import { perfPrincipal } from '../modules/perf/principal'
import { perf } from '../modules/perf/registry'
import { CollectionAnswer, type FetchOutput, resolveInstance } from '../sync/collection-fetch'
import { readKindTokens } from '../sync/kind-tokens'
import { pipeSyncBody } from '../sync/pipe-sync-body'
import { firstDownload, policyFor } from '../sync/policy'
import { openWorkerReadSession, type WorkerReadSession } from './read-session'
import {
  type BootstrapMetrics,
  jobWorkspaceId,
  SYNC_JOB_DEADLINE_MS,
  type SyncJob,
  type SyncMetaSummary,
  SyncWorkerError,
} from './types'
import { type BootstrapVisibilityOptions, bootstrapVisibility } from './visibility'

const log = createLogger('server:sync-bootstrap')
const utf8 = new TextEncoder()
/** The range every line of one snapshot answer carries. */
interface AnswerRange {
  readonly feedId: string
  readonly epoch: string
  readonly fromSeq: number
  readonly seq: number
  readonly minAvailableSeq: number
}

/**
 * The floor a range stamped at `seq` advertises (POD-7593): the true floor, but
 * never above `seq`. A log pruned to empty has floor `seq + 1`, and every
 * client's frame validator refuses `minAvailableSeq > seq`, so an honest
 * `seq + 1` turned each bootstrap of an idle workspace into another bootstrap.
 * The clamp only understates the floor by one for the client's own pre-check:
 * a frame at `seq` certifies a cursor at `seq`, which needs `floor <= seq + 1`,
 * and every refusal (this worker's and socket resume's) reads the true floor.
 * The prune planners no longer empty a log; this covers logs emptied before.
 */
function advertisedFloor(floorSeq: number, seq: number): number {
  return Math.min(floorSeq, seq)
}

/**
 * One output of the collection fetch as wire lines (POD-7085): whole records
 * in `feedBootstrap` chunks, issue stubs in `feedStubs` chunks, markers in a
 * `collectionComplete` line, every one stamped with the answer's feed number.
 * A chunk's line is assembled from its changes' JSON, each change serialized
 * once: the text that sizes it is the text that is sent (POD-7153).
 */
function outputLines(output: FetchOutput, range: AnswerRange): string[] {
  if (output.type === 'complete') {
    return [
      JSON.stringify({
        type: 'collectionComplete',
        feedId: range.feedId,
        epoch: range.epoch,
        seq: range.seq,
        instances: output.instances,
      }),
    ]
  }
  const stub = output.type === 'stubs'
  // `{"type":…,"minAvailableSeq":…` without its closing brace.
  const head = JSON.stringify({ type: stub ? 'feedStubs' : 'feedBootstrap', ...range }).slice(0, -1)
  const tail = stub ? ']}' : '],"last":false}'
  const lines: string[] = []
  let batch: string[] = []
  let bytes = 0
  const close = () => {
    if (batch.length === 0) return
    lines.push(`${head},"changes":[${batch.join(',')}${tail}`)
    batch = []
    bytes = 0
  }
  for (const record of output.records) {
    const change = JSON.stringify({
      seq: range.seq,
      entity: record.entity,
      entityId: record.entityId,
      op: 'upsert',
      ...(stub ? { part: 'stub' } : {}),
      value: record.value,
    })
    const size = Buffer.byteLength(change, 'utf8')
    if (
      batch.length > 0 &&
      (batch.length >= SYNC_BATCH_MAX_ROWS || bytes + size > SYNC_BATCH_TARGET_BYTES)
    )
      close()
    batch.push(change)
    bytes += size + 1
  }
  close()
  return lines
}

/**
 * One read session per active job in the one worker (`read-session.ts`): on SQLite a
 * read-only WAL connection of its own, on Postgres one pooled connection in a
 * REPEATABLE READ READ ONLY transaction, chosen by the store's location. Holding the
 * snapshot for a transfer prevents SQLite checkpointing past it (and Postgres vacuum
 * from removing the row versions it sees) until completion/cancel; the ten-minute
 * admission deadline bounds this window.
 */
async function* produceRecords(
  location: string,
  job: SyncJob,
  signal: AbortSignal,
  onMeta: (meta: SyncMetaSummary) => void,
  onMetrics?: (metrics: BootstrapMetrics) => void,
  options: Omit<BootstrapVisibilityOptions, 'workspaceId'> = {},
): AsyncGenerator<Uint8Array> {
  const started = performance.now()
  const attribution = perfPrincipal(jobWorkspaceId(job), job.principal)
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
  let session: WorkerReadSession | undefined
  let rows = 0,
    records = 0,
    bytesBefore = 0,
    bytesAfter = 0
  let outcome = 'producer-failed'
  /** One wire line: a record to serialize, or a line's JSON text already serialized. */
  const line = (record: unknown) => {
    const t = performance.now()
    const bytes = utf8.encode(`${typeof record === 'string' ? record : JSON.stringify(record)}\n`)
    phase('encode', t, bytes.byteLength)
    if (bytes.byteLength - 1 > SYNC_LINE_MAX_BYTES) throw new SyncWorkerError('row-too-large')
    bytesBefore += bytes.byteLength
    bytesAfter += bytes.byteLength
    records++
    return bytes
  }
  try {
    // One snapshot per answer (POD-7085): the collections and the feed number
    // they are complete as of are read in this one read session. The
    // transaction may idle between pages while the client drains them; the
    // job's deadline, not the engine's idle limit, ends it.
    session = await openWorkerReadSession(location, {
      idleBudgetMs: (job.deadlineMs ?? Date.now() + SYNC_JOB_DEADLINE_MS) - Date.now(),
    })
    const capture = performance.now()
    // This FIRST read fixes the snapshot, on either engine; every visibility read
    // shares it. Every read is the job's workspace's (POD-7021).
    const bundle = bootstrapVisibility(session.executor, {
      ...options,
      workspaceId: jobWorkspaceId(job),
    })
    const context = await bundle.context
    const { headSeq: seq, floorSeq } = await context.sync.readFeedState()
    phase('capture', capture)
    if (job.mode === 'delta') {
      const target = job.to ?? seq
      if (job.from > seq || target > seq) throw new SyncWorkerError('future-cursor')
      // The refusal reads the TRUE floor; only the advertised one is clamped.
      if (floorSeq > job.from + 1) throw new SyncWorkerError('compacted-or-unknown')
      const minAvailableSeq = advertisedFloor(floorSeq, target)
      const { policy, anchors, sync } = context
      const kindTokens = await readKindTokens(sync, options.effectKinds)
      const iterator = scopeChangesRange(
        sync,
        { policy, anchors, rescopeThreshold: FEED_RESCOPE_THRESHOLD },
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
          kindTokens,
          policy: policyFor(job.clientType),
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
          const changes = delivery.changes
          rows += changes.length
          yield line({
            type: 'feedDelta',
            feedId: job.feedId,
            epoch: job.epoch,
            fromSeq: delivery.fromSeq,
            seq: delivery.throughSeq,
            // Each frame at its own stamp, so no frame can carry a floor above it.
            minAvailableSeq: advertisedFloor(floorSeq, delivery.throughSeq),
            changes,
            // The principal's access moved in this range (POD-6947): the same
            // feed fact the main thread's frame carries.
            ...(delivery.access ? { access: true } : {}),
          })
          await yieldLoop()
          check()
          try {
            next = await iterator.next()
          } catch {
            // After `syncMeta`, every failure is `read-failed`, a
            // `ChangeRangeBootstrapRequired` included: the wire has no
            // `compacted-or-unknown` once the stream has started. That is still
            // safe. Every frame already sent passed its own floor check, the
            // client keeps them and retries from its cursor, and the retry is
            // refused up front from the snapshot's floor, which bootstraps. Only
            // a refusal on the FIRST page answers `compacted-or-unknown` directly.
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
    // Everything below reads inside the snapshot fixed by the head read
    // (design POD-6253 §4, POD-7059 "One snapshot per answer"): every record
    // and every marker is stamped with that head number.
    const { policy: world, records: source, sync, collections } = context
    const kindTokens = await readKindTokens(sync, options.effectKinds)
    check()
    // The first download is the policy's collections in its order (POD-7085).
    const syncPolicy = policyFor(job.clientType)
    const minAvailableSeq = advertisedFloor(floorSeq, seq)
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
      kindTokens,
      policy: syncPolicy,
      // No `totalRows`: the count is known only once every table is read, and
      // the load streams in one pass.
    }
    const metaBytes = line(meta)
    // Copy fields from the serialized first line, never a second world read.
    onMeta(JSON.parse(new TextDecoder().decode(metaBytes)) as SyncMetaSummary)
    yield metaBytes
    const range = { feedId: job.feedId, epoch: job.epoch, fromSeq: 0, seq, minAvailableSeq }
    const answer = new CollectionAnswer({
      collections,
      records: source,
      visibility: world,
      principal: job.principal,
      now: options.now?.() ?? Date.now(),
      policyArgs: { recentDays: syncPolicy.recentDays },
    })
    const instances =
      job.mode === 'collections' ? job.instances : firstDownload(syncPolicy, job.view ?? [])
    for (const instance of instances) {
      const outputs = answer.instance(resolveInstance(instance))
      for await (const output of outputs) {
        check()
        for (const text of outputLines(output, range)) yield line(text)
        if (output.type !== 'complete') {
          rows += output.records.length
          refCount += output.records.length
        }
        await yieldLoop()
        check()
      }
    }
    heapAfterPrefetch = process.memoryUsage().heapUsed
    // The first download ends as a start-up load does: one last chunk,
    // carrying the total once it is known.
    if (job.mode !== 'collections')
      yield line({ type: 'feedBootstrap', ...range, changes: [], last: true, totalRows: rows })
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
    // A failure the job does not name keeps its cause in the log: the client
    // only learns `producer-failed`.
    if (reason === 'producer-failed')
      log.warn('sync job failed', { transferId: job.transferId, err: error })
    if (reason === 'row-too-large') {
      yield line({ type: 'syncError', transferId: job.transferId, reason })
      return // Let the content encoder finish its trailer before reporting the typed failure.
    }
    throw error instanceof SyncWorkerError ? error : new SyncWorkerError(reason)
  } finally {
    // Ends the snapshot and releases the connection.
    if (session) await session.close()
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

/**
 * The entire content-coding pipeline stays in this worker, including codec flushing.
 * `location` is the store's: a SQLite file path or a `postgres://` URL.
 */
export async function* produceBootstrap(
  location: string,
  job: SyncJob,
  signal: AbortSignal,
  onMeta: (meta: SyncMetaSummary) => void,
  onMetrics?: (metrics: BootstrapMetrics) => void,
  options: Omit<BootstrapVisibilityOptions, 'workspaceId'> = {},
): AsyncGenerator<Uint8Array> {
  const lifetime = new AbortController()
  const abort = () => lifetime.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const telemetry: { metrics?: BootstrapMetrics } = {}
  const records = produceRecords(
    location,
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
