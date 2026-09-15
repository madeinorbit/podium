import { InMemoryReplicaStore, Replica } from '@podium/sync/replica'
import { FeedSink } from '../replica/feed/sink'
import { describe, expect, it, vi } from 'vitest'
import { FeedAuthorityClient } from '../replica/feed/authority-client'
import { SYNC_LINE_MAX_BYTES, WIRE_VERSION } from '@podium/protocol'
import { HttpBootstrapSource, HttpDeltaSource, NdjsonLineReader, readSyncStream, SyncAuthExpiredError, SyncCancelledError, SyncCorruptContentError, SyncFormatError, SyncLineTooLargeError, SyncNetworkError, SyncStreamFailed } from './index'

const encoder = new TextEncoder()
const cursor = { feedId: 'feed-1', epoch: 'epoch-1', seq: 5 }
const meta = { type: 'syncMeta', formatVersion: 1, mode: 'snapshot', transferId: 't', feedId: cursor.feedId, epoch: cursor.epoch, seq: 10, minAvailableSeq: 0, wireVersion: WIRE_VERSION, wireSchemaDigest: '0123456789abcdef', totalRows: 1 }
const row = { seq: 1, entity: 'future-kind', entityId: 'one', op: 'upsert', value: { title: 'é 🦊' } }
const chunk = { type: 'feedBootstrap', feedId: cursor.feedId, epoch: cursor.epoch, fromSeq: 0, seq: 10, minAvailableSeq: 0, changes: [row], last: true }
const complete = { type: 'syncComplete', transferId: 't', seq: 10, records: 1, rows: 1 }
const deltaMeta = { ...meta, mode: 'delta', fromSeq: 5, totalRows: undefined }
const delta = { type: 'feedDelta', feedId: cursor.feedId, epoch: cursor.epoch, fromSeq: 5, seq: 10, minAvailableSeq: 0, changes: [{ ...row, seq: 6 }] }
function byteStream(parts: Uint8Array[]) {
  let index = 0
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index === parts.length) controller.close()
    else controller.enqueue(parts[index++]!)
  })
  const cancel = vi.fn()
  return { body: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), pull, cancel }
}
function wire(values: unknown[]) { return values.map(value => JSON.stringify(value) + '\n') }
function response(values: unknown[]) {
  return new Response(byteStream(wire(values).map(line => encoder.encode(line))).body, { headers: { 'content-type': 'application/x-ndjson' } })
}
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const item of items) output.push(item)
  return output
}
async function* lines(values: unknown[]) { yield* values.map(value => JSON.stringify(value)) }
function sources(reply: () => Response | Promise<Response>) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => reply())
  const deps = { origin: 'https://example.test/', streamingFetch: { fetch, credentials: 'omit' as const, headers: () => ({ Authorization: 'Bearer test' }) }, onMeta: vi.fn(), onChunk: vi.fn() }
  return { bootstrap: new HttpBootstrapSource(deps), delta: new HttpDeltaSource(deps), fetch, deps }
}

describe('NdjsonLineReader', () => {
  it('decodes every possible split, including inside multibyte UTF-8', async () => {
    const text = 'aé🦊\n日本語\nend\n'
    const bytes = encoder.encode(text)
    for (let split = 0; split <= bytes.length; split++) {
      expect(await collect(NdjsonLineReader(byteStream([bytes.subarray(0, split), bytes.subarray(split)]).body))).toEqual(['aé🦊', '日本語', 'end'])
    }
    expect(await collect(NdjsonLineReader(byteStream([...bytes].map(byte => Uint8Array.of(byte))).body))).toEqual(['aé🦊', '日本語', 'end'])
  })
  it('yields 100 lines from one read without reading ahead', async () => {
    const expected = Array.from({ length: 100 }, (_, i) => String(i))
    const stream = byteStream([encoder.encode(expected.join('\n') + '\n')])
    const reader = NdjsonLineReader(stream.body)
    expect(stream.pull).not.toHaveBeenCalled()
    for (const line of expected) {
      expect(await reader.next()).toEqual({ value: line, done: false })
      expect(stream.pull).toHaveBeenCalledTimes(1)
    }
    expect((await reader.next()).done).toBe(true)
  })
  it('refuses oversized bytes before decoding or extending a partial line', async () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    const stream = byteStream([new Uint8Array(SYNC_LINE_MAX_BYTES + 1).fill(120)])
    await expect(collect(NdjsonLineReader(stream.body))).rejects.toBeInstanceOf(SyncLineTooLargeError)
    expect(decode).not.toHaveBeenCalled()
    decode.mockRestore()
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    const partial = byteStream([new Uint8Array(SYNC_LINE_MAX_BYTES).fill(120), Uint8Array.of(120)])
    await expect(collect(NdjsonLineReader(partial.body))).rejects.toBeInstanceOf(SyncLineTooLargeError)
  })
  it('accepts exactly the byte limit', async () => {
    const stream = byteStream([new Uint8Array(SYNC_LINE_MAX_BYTES).fill(120), Uint8Array.of(10)])
    expect((await collect(NdjsonLineReader(stream.body)))[0]?.length).toBe(SYNC_LINE_MAX_BYTES)
  })
  it.each([['CRLF', encoder.encode('a\r\n')], ['unterminated', encoder.encode('a')], ['invalid UTF-8', Uint8Array.of(255, 10)], ['unfinished UTF-8', Uint8Array.of(0xc3)]])('rejects %s', async (_label, bytes) => {
    await expect(collect(NdjsonLineReader(byteStream([bytes]).body))).rejects.toBeInstanceOf(SyncCorruptContentError)
  })
  it('cancels on early iterator return and releases its lock', async () => {
    const stream = byteStream([encoder.encode('a\nb\n')])
    for await (const _line of NdjsonLineReader(stream.body)) break
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(stream.body.locked).toBe(false)
  })
})

describe('readSyncStream', () => {
  it('validates snapshot and delta records with lenient future entity kinds', async () => {
    expect((await collect(readSyncStream(lines([meta, chunk, complete])))).map(r => r.type)).toEqual(['syncMeta', 'feedBootstrap', 'syncComplete'])
    expect((await collect(readSyncStream(lines([deltaMeta, delta, complete])))).map(r => r.type)).toEqual(['syncMeta', 'feedDelta', 'syncComplete'])
  })
  it('ignores future record types only after meta', async () => {
    expect(await collect(readSyncStream(lines([meta, { type: 'future' }, chunk, complete])))).toHaveLength(3)
    await expect(collect(readSyncStream(lines([{ type: 'future' }, meta, chunk, complete])))).rejects.toMatchObject({ reason: 'meta-required' })
  })
  it.each([
    ['missing-complete', [meta, chunk]],
    ['record-after-complete', [meta, chunk, complete, { type: 'future' }]],
    ['complete-seq-mismatch', [meta, chunk, { ...complete, seq: 9 }]],
    ['transfer-mismatch', [meta, chunk, { ...complete, transferId: 'other' }]],
    ['count-mismatch', [meta, chunk, { ...complete, rows: 2 }]],
    ['data-after-last', [meta, chunk, chunk, complete]],
    ['duplicate-meta', [meta, meta]],
    ['identity-mismatch', [meta, { ...chunk, epoch: 'other' }]],
    ['non-chaining', [deltaMeta, { ...delta, fromSeq: 4 }]],
    ['final-bootstrap-required', [meta, { ...chunk, last: false }, complete]],
  ])('fails %s', async (reason, values) => {
    await expect(collect(readSyncStream(lines(values)))).rejects.toMatchObject({ reason })
  })
  it('preserves server failure reasons', async () => {
    await expect(collect(readSyncStream(lines([meta, { type: 'syncError', transferId: 't', reason: 'deadline' }])))).rejects.toMatchObject({ reason: 'deadline' })
  })
  it('distinguishes incompatible format versions', async () => {
    await expect(collect(readSyncStream(lines([{ ...meta, formatVersion: 2 }])))).rejects.toBeInstanceOf(SyncFormatError)
  })
})

describe('HTTP sources', () => {
  it('yields bootstrap data before completion and emits last only after EOF', async () => {
    const stream = byteStream(wire([meta, chunk, complete]).map(line => encoder.encode(line)))
    const source = sources(() => new Response(stream.body, { headers: { 'content-type': 'application/x-ndjson' } }))
    const iterator = source.bootstrap.bootstrap()
    expect((await iterator.next()).value).toMatchObject({ last: false, changes: [{ payload: row.value }] })
    expect(stream.pull).toHaveBeenCalledTimes(2)
    expect((await iterator.next()).value).toMatchObject({ last: true, changes: [], snapshotSeq: 10 })
    expect(stream.pull).toHaveBeenCalledTimes(4)
    expect(source.deps.onMeta).toHaveBeenCalledWith(1)
    expect(source.deps.onChunk).toHaveBeenCalledWith(1, encoder.encode(JSON.stringify(chunk)).length)
    expect(source.fetch).toHaveBeenCalledWith('https://example.test/sync/bootstrap', expect.objectContaining({ credentials: 'omit', headers: { Authorization: 'Bearer test' } }))
    await iterator.return(undefined)
  })
  it('does not install a truncated snapshot or one with trailing records', async () => {
    for (const values of [[meta, chunk], [meta, chunk, complete, chunk]]) {
      const iterator = sources(() => response(values)).bootstrap.bootstrap()
      expect((await iterator.next()).value?.last).toBe(false)
      await expect(iterator.next()).rejects.toBeInstanceOf(SyncStreamFailed)
    }
  })
  it('aborts a pending body read and passes the generation signal to fetch', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })
    const source = sources(() => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }))
    const controller = new AbortController()
    const authority = new FeedAuthorityClient({ bootstraps: source.bootstrap, fetchChangesSince: async () => ({ kind: 'bootstrap-required' }) })
    const pending = authority.bootstrap(controller.signal)[Symbol.asyncIterator]().next()
    // Wait for fetch admission without a timer or transport read-ahead.
    await vi.waitFor(() => expect(body.locked).toBe(true))
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(SyncCancelledError)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(source.fetch.mock.calls[0]?.[1].signal).toBe(controller.signal)
    expect(body.locked).toBe(false)
  })
  it('does not fetch an already cancelled generation', async () => {
    const source = sources(() => response([]))
    const controller = new AbortController()
    controller.abort()
    await expect(source.bootstrap.bootstrap(controller.signal).next()).rejects.toBeInstanceOf(SyncCancelledError)
    expect(source.fetch).not.toHaveBeenCalled()
  })
  it.each(['feed-identity-mismatch', 'compacted-or-unknown', 'rescope', 'future-cursor', 'invalid-target'])('maps 409 %s', async reason => {
    const source = sources(() => new Response(JSON.stringify({ kind: 'bootstrap-required', reason }), { status: 409 }))
    expect(await source.delta.changesRange(cursor)).toEqual({ kind: 'bootstrap-required', reason })
  })
  it('rejects malformed refusals', async () => {
    await expect(sources(() => new Response('{}', { status: 409 })).delta.changesRange(cursor)).rejects.toBeInstanceOf(SyncCorruptContentError)
  })
  it('keeps auth and network errors distinct without retry', async () => {
    const auth = sources(() => new Response(null, { status: 401 }))
    await expect(auth.delta.changesRange(cursor)).rejects.toBeInstanceOf(SyncAuthExpiredError)
    expect(auth.fetch).toHaveBeenCalledTimes(1)
    const network = sources(() => { throw new TypeError('offline') })
    await expect(network.delta.changesRange(cursor)).rejects.toBeInstanceOf(SyncNetworkError)
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })
  it('streams chained delta certificates with a fixed target and omits to', async () => {
    const first = { ...delta, seq: 7 }
    const second = { ...delta, fromSeq: 7, changes: [{ ...row, seq: 9 }] }
    const source = sources(() => response([deltaMeta, first, second, { ...complete, records: 2, rows: 2 }]))
    const target = vi.fn()
    const range = await source.delta.changesRange(cursor, undefined, target)
    const reply = await collectRange(Promise.resolve(range))
    expect(target).toHaveBeenCalledWith({ ...cursor, seq: 10 })
    expect(reply).toMatchObject([{ fromSeq: 5, seq: 7, changes: [{ seq: 6 }] }, { fromSeq: 7, seq: 10, changes: [{ seq: 9 }] }])
    expect(source.fetch.mock.calls[0]?.[0]).toBe('https://example.test/sync/delta?feedId=feed-1&epoch=epoch-1&from=5')
  })
  it('rejects a broken delta chain and a mismatched requested cursor', async () => {
    await expect(collectRange(sources(() => response([deltaMeta, { ...delta, fromSeq: 4 }, complete])).delta.changesRange(cursor))).rejects.toMatchObject({ reason: 'non-chaining' })
    await expect(collectRange(sources(() => response([deltaMeta, delta, complete])).delta.changesRange({ ...cursor, seq: 4 }))).rejects.toMatchObject({ reason: 'requested-cursor-mismatch' })
  })
  it('collects a certified equal-endpoint range, but still requires complete', async () => {
    const start = { ...deltaMeta, seq: 5 }
    const end = { ...complete, seq: 5, records: 0, rows: 0 }
    expect(await collectRange(sources(() => response([start, end])).delta.changesRange(cursor))).toMatchObject([{ fromSeq: 5, seq: 5, changes: [] }])
    await expect(collectRange(sources(() => response([start])).delta.changesRange(cursor))).rejects.toMatchObject({ reason: 'missing-complete' })
  })
})

async function collectRange(pending: ReturnType<HttpDeltaSource['changesRange']>) {
  const range = await pending
  if ('kind' in range) throw new Error('expected delta range')
  const frames = []
  for await (const frame of range) frames.push(frame)
  return frames
}


describe('HTTP bootstrap with a live socket', () => {
  it('bounds live frames during an HTTP walk and starts a replacement transfer on overflow', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal)
      return new Response(new ReadableStream<Uint8Array>(), { headers: { 'content-type': 'application/x-ndjson' } })
    })
    const bootstraps = new HttpBootstrapSource({ origin: 'https://example.test', streamingFetch: { fetch } })
    const store = new InMemoryReplicaStore()
    const replica = new Replica({ store: store.viewFor('default').cache,
      authority: { bootstrap: signal => bootstraps.bootstrap(signal), changesRange: async () => ({ kind: 'bootstrap-required' }) } })
    const sink = new FeedSink({ replica, bootstraps })
    sink.connected(false)
    for (let seq = 1; seq <= 10_001; seq++) {
      await replica.receive({ kind: 'delta', feedId: cursor.feedId, epoch: cursor.epoch, fromSeq: seq - 1, seq, minAvailableSeq: 0, changes: [] })
    }
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    replica.disconnect()
    await replica.settled()
  })

  it.each([false, true])('folds live frames once and preserves the HTTP walk across a socket drop: %s', async (dropDuringWalk) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let signal: AbortSignal | null | undefined
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal
      return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c } }), {
        headers: { 'content-type': 'application/x-ndjson' },
      })
    })
    const bootstraps = new HttpBootstrapSource({ origin: 'https://example.test', streamingFetch: { fetch } })
    const changesRange = vi.fn(async function* (from: { seq: number }) {
      yield { kind: 'delta' as const, feedId: cursor.feedId, epoch: cursor.epoch, fromSeq: from.seq, seq: 13, minAvailableSeq: 0,
        changes: [11, 12, 13].filter(seq => seq > from.seq).map(seq => ({ seq, entity: 'future-kind', entityId: String(seq), op: 'upsert' as const, payload: { seq } })) }
    })
    const store = new InMemoryReplicaStore()
    const replica = new Replica({ store: store.viewFor('default').cache, authority: { bootstrap: signal => bootstraps.bootstrap(signal), changesRange } })
    const sink = new FeedSink({ replica, bootstraps })
    sink.connected(false)
    await vi.waitFor(() => expect(controller).toBeDefined())
    for (const value of [meta, chunk]) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'))
    for (const seq of [11, 12, 13]) {
      sink.frame({ type: 'feedDelta', feedId: cursor.feedId, epoch: cursor.epoch, fromSeq: seq - 1, seq, minAvailableSeq: 0,
        changes: [{ seq, entity: 'future-kind', entityId: String(seq), op: 'upsert', value: { seq } }] })
    }
    if (dropDuringWalk) {
      sink.disconnected()
      expect(signal?.aborted).toBe(false)
      expect(replica.posture).toBe('bootstrapping')
      sink.connected(false)
    }
    controller.enqueue(encoder.encode(JSON.stringify(complete) + '\n'))
    controller.close()
    await replica.settled()
    expect(replica.cursor?.seq).toBe(13)
    expect(replica.entities().map(row => row.entityId).sort()).toEqual(['11', '12', '13', 'one'])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(changesRange).toHaveBeenCalledTimes(dropDuringWalk ? 1 : 0)
    sink.disconnected()
    expect(sink.helloFields()?.feedCursor.seq).toBe(13)
    sink.connected(false)
    sink.frame({ type: 'feedResume', feedId: cursor.feedId, epoch: cursor.epoch, seq: 13 })
    await replica.settled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(replica.cursor?.seq).toBe(13)
  })
})
