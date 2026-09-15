import { SYNC_CONTENT_TYPE, SyncBootstrapRequired, type SyncMeta } from '@podium/protocol'
import type { BootstrapChunk, BootstrapRequired, ChangesSinceReply, Cursor, DeltaFrame } from '@podium/sync/replica'
import { toBootstrapChunk, toDeltaFrame } from '../replica/feed/frames'
import { SyncAuthExpiredError, SyncCancelledError, SyncCorruptContentError, SyncFormatError, SyncNetworkError } from './errors'
import { NdjsonLineReader } from './ndjson-reader'
import { readSyncStream } from './read-sync-stream'

/** Web injects cookies; Expo injects expo/fetch and current bearer headers. */
export interface StreamingFetchPort {
  fetch(input: string, init: RequestInit): Promise<Response>
  credentials?: RequestCredentials
  headers?: () => HeadersInit
}
export interface HttpSyncSourceDeps {
  origin: string
  streamingFetch: StreamingFetchPort
  onMeta?: (totalRows: number | undefined) => void
  /** Per data record: rows and decoded UTF-8 bytes, excluding LF. */
  onChunk?: (rows: number, bytes: number) => void
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncCancelledError()
}
async function request(deps: HttpSyncSourceDeps, path: string, signal?: AbortSignal): Promise<Response> {
  checkAbort(signal)
  const port = deps.streamingFetch
  let response: Response
  try {
    response = await port.fetch(deps.origin.replace(/\/$/, '') + path, {
      method: 'GET', credentials: port.credentials, headers: port.headers?.(), signal,
    })
  } catch (cause) {
    checkAbort(signal)
    throw new SyncNetworkError('fetch-failed', { cause })
  }
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined)
    throw new SyncCancelledError()
  }
  if (response.status === 409) return response
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) throw new SyncAuthExpiredError(`http-${response.status}`)
    if (response.status === 426) throw new SyncFormatError('unsupported-version')
    if (response.status >= 500) throw new SyncNetworkError(`http-${response.status}`)
    throw new SyncFormatError(`http-${response.status}`)
  }
  if (response.headers.get('content-type')?.split(';')[0]?.trim() !== SYNC_CONTENT_TYPE) {
    void response.body?.cancel().catch(() => undefined)
    throw new SyncFormatError('unexpected-content-type')
  }
  return response
}
function bodyOf(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new SyncFormatError('streaming-body-required')
  return response.body
}
async function* records(response: Response, deps: HttpSyncSourceDeps, signal?: AbortSignal) {
  let bytes = 0
  async function* lines() {
    const encoder = new TextEncoder()
    for await (const line of NdjsonLineReader(bodyOf(response), signal)) {
      bytes = encoder.encode(line).byteLength
      yield line
    }
  }
  for await (const record of readSyncStream(lines())) {
    checkAbort(signal)
    if (record.type === 'syncMeta') deps.onMeta?.(record.totalRows)
    if (record.type === 'feedBootstrap' || record.type === 'feedDelta') deps.onChunk?.(record.changes.length, bytes)
    yield record
  }
}
/** One fetch per attempt; the replica owns the bounded restart ladder. */
export class HttpBootstrapSource {
  constructor(private readonly deps: HttpSyncSourceDeps) {}
  async *bootstrap(signal?: AbortSignal): AsyncGenerator<BootstrapChunk> {
    const response = await request(this.deps, '/sync/bootstrap', signal)
    if (response.status === 409) {
      void response.body?.cancel().catch(() => undefined)
      throw new SyncFormatError('unexpected-bootstrap-refusal')
    }
    let meta: SyncMeta | undefined
    for await (const record of records(response, this.deps, signal)) {
      if (record.type === 'syncMeta') {
        if (record.mode !== 'snapshot') throw new SyncCorruptContentError('snapshot-meta-required')
        meta = record
      } else if (record.type === 'feedBootstrap') {
        yield { ...toBootstrapChunk(record), last: false }
      } else if (record.type === 'syncComplete' && meta) {
        yield { feedId: meta.feedId, epoch: meta.epoch, snapshotSeq: meta.seq, changes: [], last: true }
      }
    }
  }
}

/** Only refusals are JSON; cap them independently of the data-line budget. */
async function refusal(response: Response, signal?: AbortSignal): Promise<BootstrapRequired> {
  const reader = bodyOf(response).getReader()
  const cancel = (): void => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let json = ''
  let bytes = 0
  try {
    for (;;) {
      checkAbort(signal)
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await reader.read() }
      catch (cause) { checkAbort(signal); throw new SyncNetworkError('refusal-read-failed', { cause }) }
      checkAbort(signal)
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 4096) throw new SyncCorruptContentError('refusal-too-large')
      json += decoder.decode(next.value, { stream: true })
    }
    json += decoder.decode()
    const parsed = SyncBootstrapRequired.safeParse(JSON.parse(json))
    if (!parsed.success) throw new SyncCorruptContentError('invalid-bootstrap-refusal')
    return parsed.data
  } catch (cause) {
    checkAbort(signal)
    if (cause instanceof SyncCorruptContentError || cause instanceof SyncNetworkError) throw cause
    throw new SyncCorruptContentError('invalid-bootstrap-refusal', { cause })
  } finally {
    signal?.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}
export class HttpDeltaSource {
  constructor(private readonly deps: HttpSyncSourceDeps) {}
  async changesRange(cursor: Cursor, signal?: AbortSignal): Promise<AsyncIterable<DeltaFrame> | BootstrapRequired> {
    const query = new URLSearchParams({ feedId: cursor.feedId, epoch: cursor.epoch, from: String(cursor.seq) })
    const response = await request(this.deps, `/sync/delta?${query}`, signal)
    if (response.status === 409) return refusal(response, signal)
    const deps = this.deps
    return (async function* () {
      for await (const record of records(response, deps, signal)) {
        if (record.type === 'syncMeta') {
          if (record.mode !== 'delta' || record.feedId !== cursor.feedId || record.epoch !== cursor.epoch || record.fromSeq !== cursor.seq) {
            throw new SyncCorruptContentError('requested-cursor-mismatch')
          }
          // Preserve the retention certificate for an equal-endpoint range.
          if (record.seq === cursor.seq) yield { kind: 'delta', ...cursor, fromSeq: cursor.seq, minAvailableSeq: record.minAvailableSeq, changes: [] }
        } else if (record.type === 'feedDelta') yield toDeltaFrame(record)
      }
    })()
  }
  async changesSince(cursor: Cursor, signal?: AbortSignal): Promise<ChangesSinceReply> {
    const range = await this.changesRange(cursor, signal)
    if ('kind' in range) return range
    let collected: DeltaFrame | undefined
    const changes: DeltaFrame['changes'][number][] = []
    for await (const frame of range) {
      for (const change of frame.changes) changes.push(change)
      collected = frame
    }
    if (!collected) throw new SyncCorruptContentError('empty-uncertified-range')
    return { ...collected, fromSeq: cursor.seq, changes }
  }
}
