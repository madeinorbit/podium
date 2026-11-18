import {
  CLIENT_TYPE_HEADER,
  type ClientType,
  type CollectionInstance,
  SYNC_CONTENT_TYPE,
  SyncBootstrapRequired,
  type SyncMeta,
} from '@podium/protocol'
import type {
  AuthorityReadPort,
  BootstrapChunk,
  BootstrapRequired,
  CachePolicy,
  Cursor,
  DeltaFrame,
  InstanceRequest,
} from '@podium/sync/replica'
import { toBootstrapChunk, toDeltaFrame, toMarkerChunk, toStubChunk } from '../replica/feed/frames'
import { SyncAuthExpiredError, SyncCancelledError, SyncCorruptContentError, SyncFormatError, SyncNetworkError, SyncStreamFailed } from './errors'
import { NdjsonLineReader } from './ndjson-reader'
import { readSyncStream } from './read-sync-stream'
import type { SyncTransferAttempt, SyncTransferTelemetry } from './transfer-telemetry'

/** Web injects cookies; Expo injects expo/fetch and current bearer headers. */
export interface StreamingFetchPort {
  fetch(input: string, init: RequestInit): Promise<Response>
  credentials?: RequestCredentials
  headers?: () => HeadersInit
}
export interface HttpSyncSourceDeps {
  origin: string
  streamingFetch: StreamingFetchPort
  /** What kind of app this is; the server's policy is per client type (POD-7085). */
  clientType?: ClientType
  onMeta?: (totalRows: number | undefined) => void
  /** Per data record: rows and decoded UTF-8 bytes, excluding LF. */
  onChunk?: (rows: number, bytes: number) => void
  /**
   * POD-4071 — the client half of the transfer timeline, at DEBUG.
   *
   * Optional, and absent it costs a handful of `?.` checks: this is the one
   * module web, the desktop webview (which loads `apps/web/dist`) and Expo
   * native all reach the server through, so instrumenting it instruments every
   * client exactly once.
   */
  telemetry?: SyncTransferTelemetry
}

/** The `url` on the started line is the one the fetch below will really use. */
function beginAttempt(deps: HttpSyncSourceDeps, mode: 'bootstrap' | 'delta' | 'collections', path: string): SyncTransferAttempt | undefined {
  return deps.telemetry?.begin(mode, deps.origin.replace(/\/$/, '') + path, deps.streamingFetch.headers?.())
}

/**
 * The terminal reason, kept short and stable enough to group a log by.
 *
 * Every error on this path carries a `reason` that is already a closed
 * vocabulary (`http-401`, `body-read-failed`, `unsupported-version`), so the
 * class alone would throw away the half that says what happened. Nothing here
 * reaches for a message a payload could have influenced.
 */
function reasonOf(error: unknown): string {
  if (error instanceof SyncStreamFailed) return `${error.name}:${error.reason}`
  if (error instanceof Error) return error.name === 'Error' ? error.message : error.name
  return String(error)
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncCancelledError()
}
async function request(deps: HttpSyncSourceDeps, path: string, attempt: SyncTransferAttempt | undefined, signal?: AbortSignal, extra?: Record<string, string>, body?: unknown): Promise<Response> {
  checkAbort(signal)
  const port = deps.streamingFetch
  let response: Response
  const headers: Record<string, string> = {
    ...(port.headers?.() as Record<string, string> | undefined),
    ...(deps.clientType === undefined ? {} : { [CLIENT_TYPE_HEADER]: deps.clientType }),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...extra,
  }
  try {
    response = await port.fetch(deps.origin.replace(/\/$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: port.credentials, headers, signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (cause) {
    checkAbort(signal)
    if (cause instanceof SyncStreamFailed) throw cause
    throw new SyncNetworkError('fetch-failed', { cause })
  }
  // BEFORE the refusal ladder below, so a 401/426/500 still gets its `opened`
  // line with the status that caused it. The transfer id is on the response
  // headers whatever the status is, which is what makes a refusal joinable too.
  attempt?.opened(response)
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
async function* records(response: Response, deps: HttpSyncSourceDeps, attempt?: SyncTransferAttempt, signal?: AbortSignal, finalChunk = true) {
  let bytes = 0
  async function* lines() {
    const encoder = new TextEncoder()
    for await (const line of NdjsonLineReader(bodyOf(response), signal, attempt?.meter)) {
      bytes = encoder.encode(line).byteLength
      yield line
    }
  }
  for await (const record of readSyncStream(lines(), { finalChunk })) {
    checkAbort(signal)
    if (record.type === 'syncMeta') {
      deps.onMeta?.(record.totalRows)
      attempt?.noteMeta(record.transferId, record.totalRows)
    }
    if (record.type === 'feedBootstrap' || record.type === 'feedDelta' || record.type === 'feedStubs') {
      deps.onChunk?.(record.changes.length, bytes)
      attempt?.noteData(record.changes.length)
    }
    // Everything above is decode; everything until this yield returns is the
    // consumer folding the chunk into its store. A generator is suspended inside
    // its consumer, which is the only reason that second cost is visible here.
    attempt?.enter('consumer')
    yield record
    attempt?.enter('pipeline')
  }
}
/** One fetch per attempt; the replica owns the bounded restart ladder. */
export class HttpBootstrapSource {
  /** One id per replica, kept across its retries. The server cancels an older
   *  bootstrap only for the SAME id, so one client's restarted walk replaces its
   *  own transfer while other tabs and devices of the user never cancel each other. */
  private readonly clientId = globalThis.crypto.randomUUID()
  constructor(private readonly deps: HttpSyncSourceDeps) {}
  /**
   * The first download (POD-7085): the policy's collections in its order,
   * with the visible view's instances as its second step.
   */
  async *bootstrap(
    signal?: AbortSignal,
    view?: readonly InstanceRequest[],
  ): AsyncGenerator<BootstrapChunk> {
    const path =
      view === undefined || view.length === 0
        ? '/sync/bootstrap'
        : `/sync/bootstrap?${new URLSearchParams({ view: JSON.stringify(view.map(wireInstance)) })}`
    yield* this.answer('bootstrap', path, signal, undefined)
  }

  /** `POST /sync/collections`: the named instances, records and stubs in chunks, a marker each. */
  async *collections(
    instances: readonly InstanceRequest[],
    signal?: AbortSignal,
  ): AsyncGenerator<BootstrapChunk> {
    yield* this.answer('collections', '/sync/collections', signal, {
      instances: instances.map(wireInstance),
    })
  }

  private async *answer(
    mode: 'bootstrap' | 'collections',
    path: string,
    signal: AbortSignal | undefined,
    body: unknown,
  ): AsyncGenerator<BootstrapChunk> {
    const attempt = beginAttempt(this.deps, mode, path)
    // The DEFAULT is 'cancelled', because the commonest non-completion here is
    // the Replica breaking out of its `for await` when a walk is superseded —
    // which reaches this generator as a `return()`, not as an error. That is
    // exactly the transfer the server logged as `cancelled` with zero bytes.
    let outcome = 'cancelled'
    let reason: string | undefined
    try {
      const response = await request(
        this.deps,
        path,
        attempt,
        signal,
        mode === 'bootstrap' ? { 'Podium-Sync-Client': this.clientId } : {},
        body,
      )
      if (response.status === 409) {
        void response.body?.cancel().catch(() => undefined)
        throw new SyncFormatError('unexpected-bootstrap-refusal')
      }
      let meta: SyncMeta | undefined
      let policy: CachePolicy | undefined
      for await (const record of records(response, this.deps, attempt, signal, mode === 'bootstrap')) {
        if (record.type === 'syncMeta') {
          if (record.mode !== 'snapshot') throw new SyncCorruptContentError('snapshot-meta-required')
          meta = record
          policy = record.policy
        } else if (record.type === 'feedBootstrap') {
          const chunk = toBootstrapChunk(record, meta!.kindTokens)
          // The policy rides on the first chunk the Replica sees.
          yield { ...chunk, last: false, ...(policy === undefined ? {} : { policy }) }
          policy = undefined
        } else if (record.type === 'feedStubs') {
          yield { ...toStubChunk(record, meta!.kindTokens), ...(policy === undefined ? {} : { policy }) }
          policy = undefined
        } else if (record.type === 'collectionComplete') {
          yield { ...toMarkerChunk(record, meta!.kindTokens), ...(policy === undefined ? {} : { policy }) }
          policy = undefined
        } else if (record.type === 'syncComplete' && meta) {
          // Settled BEFORE the yield: the Replica breaks on `last`, so this
          // generator is never resumed and anything after the yield is dead code.
          outcome = 'complete'
          yield {
            feedId: meta.feedId,
            epoch: meta.epoch,
            snapshotSeq: meta.seq,
            changes: [],
            last: true,
            kindTokens: meta.kindTokens,
            ...(policy === undefined ? {} : { policy }),
          }
        }
      }
    } catch (error) {
      outcome = error instanceof SyncCancelledError ? 'cancelled' : 'failed'
      reason = reasonOf(error)
      throw error
    } finally {
      attempt?.finish(outcome, reason)
    }
  }
}

/** The wire spelling of one instance: the kernel's request, field by field. */
function wireInstance(request: InstanceRequest): CollectionInstance {
  return {
    collection: request.collection,
    ...(request.args === undefined ? {} : { args: request.args as CollectionInstance['args'] }),
    ...(request.part === undefined ? {} : { part: request.part }),
    ...(request.via === undefined ? {} : { via: request.via }),
    ...(request.after === undefined
      ? {}
      : { after: request.after as unknown as NonNullable<CollectionInstance['after']> }),
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
  async changesRange(
    cursor: Cursor,
    signal?: AbortSignal,
    onTarget?: Parameters<AuthorityReadPort['changesRange']>[2],
  ): Promise<AsyncIterable<DeltaFrame> | BootstrapRequired> {
    const query = new URLSearchParams({ feedId: cursor.feedId, epoch: cursor.epoch, from: String(cursor.seq) })
    const path = `/sync/delta?${query}`
    const attempt = beginAttempt(this.deps, 'delta', path)
    let response: Response
    try {
      response = await request(this.deps, path, attempt, signal)
    } catch (error) {
      attempt?.finish(error instanceof SyncCancelledError ? 'cancelled' : 'failed', reasonOf(error))
      throw error
    }
    if (response.status === 409) {
      // A heal the authority declines to serve. It ends here, so it ends its own
      // line here — the walk it demotes to opens a bootstrap with its own id.
      try {
        const required = await refusal(response, signal)
        attempt?.finish('bootstrap-required', required.reason)
        return required
      } catch (error) {
        attempt?.finish(error instanceof SyncCancelledError ? 'cancelled' : 'failed', reasonOf(error))
        throw error
      }
    }
    const deps = this.deps
    return (async function* () {
      let outcome = 'cancelled'
      let reason: string | undefined
      try {
        for await (const record of records(response, deps, attempt, signal)) {
          if (record.type === 'syncMeta') {
            if (record.mode !== 'delta' || record.feedId !== cursor.feedId || record.epoch !== cursor.epoch || record.fromSeq !== cursor.seq) {
              throw new SyncCorruptContentError('requested-cursor-mismatch')
            }
            const target = { feedId: record.feedId, epoch: record.epoch, seq: record.seq }
            onTarget?.(target, record.kindTokens)
            // Preserve the retention certificate for an equal-endpoint range.
            if (record.seq === cursor.seq) yield { kind: 'delta', ...cursor, fromSeq: cursor.seq, minAvailableSeq: record.minAvailableSeq, changes: [] }
          } else if (record.type === 'feedDelta') yield toDeltaFrame(record)
        }
        outcome = 'complete'
      } catch (error) {
        outcome = error instanceof SyncCancelledError ? 'cancelled' : 'failed'
        reason = reasonOf(error)
        throw error
      } finally {
        attempt?.finish(outcome, reason)
      }
    })()
  }
}
