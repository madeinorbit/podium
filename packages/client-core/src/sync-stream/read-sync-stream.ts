import { parseSyncRecord, validateFeedFrame, CLIENT_WIRE_VERSION, type SyncComplete, type SyncMeta, type SyncRecordLenient } from '@podium/protocol'
import { SyncCancelledError, SyncCorruptContentError, SyncFormatError, SyncNetworkError, SyncStreamFailed } from './errors'

/**
 * The consumer vocabulary retains unknown entity kinds, as the feed parser does.
 *
 * A collection answer (`POST /sync/collections`, POD-7085) is a snapshot with
 * no final `last: true` chunk; pass `finalChunk: false` for it.
 */
export async function* readSyncStream(
  lines: AsyncIterable<string>,
  options: { readonly finalChunk?: boolean } = {},
): AsyncGenerator<SyncRecordLenient> {
  const finalChunk = options.finalChunk ?? true
  let meta: SyncMeta | undefined
  let complete: SyncComplete | undefined
  let records = 0
  let rows = 0
  let cursor = 0
  let last = false
  function fail(reason: string): never { throw new SyncCorruptContentError(reason) }
  for await (const line of lines) {
    if (complete) fail('record-after-complete')
    const parsed = parseSyncRecord(line)
    if (parsed.kind === 'refused') {
      if (parsed.reason === 'invalid-record') {
        const raw = JSON.parse(line)
        if (raw?.type === 'syncMeta' && (raw.formatVersion !== 1 || raw.wireVersion !== CLIENT_WIRE_VERSION)) {
          throw new SyncFormatError('unsupported-version')
        }
      }
      fail(parsed.reason)
    }
    if (parsed.kind === 'ignored') {
      if (!meta) fail('meta-required')
      continue
    }
    if (parsed.kind !== 'record') continue
    const record = parsed.record
    if (!meta) {
      if (record.type !== 'syncMeta') fail('meta-required')
      meta = record
      cursor = record.fromSeq ?? 0
      yield record
      continue
    }
    if (record.type === 'syncMeta') fail('duplicate-meta')
    if (record.type === 'syncError') {
      if (record.transferId !== meta.transferId) fail('transfer-mismatch')
      if (record.reason === 'cancelled') throw new SyncCancelledError()
      // A failed transfer does not make the wire format unreadable. Preserve
      // retryability so the shared assembly can resume on the next live trigger.
      switch (record.reason) {
        case 'compressor-failed':
        case 'read-failed':
        case 'deadline':
        case 'server-shutdown':
          throw new SyncNetworkError(record.reason)
      }
      throw new SyncStreamFailed(record.reason)
    }
    if (record.type === 'syncComplete') {
      if (record.transferId !== meta.transferId) fail('transfer-mismatch')
      if (record.seq !== meta.seq) fail('complete-seq-mismatch')
      if (record.records !== records || record.rows !== rows) fail('count-mismatch')
      if (meta.mode === 'delta' && cursor !== meta.seq) fail('incomplete-range')
      if (meta.mode === 'snapshot' && finalChunk && (!last || records === 0)) fail('final-bootstrap-required')
      if (meta.totalRows !== undefined && meta.totalRows !== rows) fail('total-rows-mismatch')
      complete = record
      continue
    }
    if (record.type === 'feedStubs' || record.type === 'collectionComplete') {
      // Stubs and markers (POD-7085) belong to a snapshot and count as its data lines.
      if (meta.mode !== 'snapshot') fail('bootstrap-required')
      if (last) fail('data-after-last')
      if (record.feedId !== meta.feedId || record.epoch !== meta.epoch) fail('identity-mismatch')
      if (record.seq !== meta.seq) fail('snapshot-range-mismatch')
      records++
      if (record.type === 'feedStubs') rows += record.changes.length
      yield record
      continue
    }
    if (record.type !== 'feedBootstrap' && record.type !== 'feedDelta') continue
    if (record.feedId !== meta.feedId || record.epoch !== meta.epoch) fail('identity-mismatch')
    const violations = validateFeedFrame(record)
    if (violations.length) fail(violations.join(','))
    if (meta.mode === 'snapshot') {
      if (record.type !== 'feedBootstrap') fail('bootstrap-required')
      if (last) fail('data-after-last')
      if (record.seq !== meta.seq || record.fromSeq !== 0 || record.minAvailableSeq !== meta.minAvailableSeq) fail('snapshot-range-mismatch')
      last = record.last
    } else {
      if (record.type !== 'feedDelta') fail('delta-required')
      if (record.fromSeq !== cursor) fail('non-chaining')
      if (record.seq > meta.seq) fail('target-exceeded')
      cursor = record.seq
    }
    records++
    rows += record.changes.length
    yield record
  }
  if (!complete) throw new SyncNetworkError('missing-complete')
  // Completion is withheld until EOF, so even legacy bootstrap callers which
  // stop on last=true cannot silently accept trailing records or corrupt bytes.
  yield complete
}
