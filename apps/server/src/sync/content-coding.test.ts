import { describe, expect, it, vi } from 'vitest'
import { SYNC_BATCH_MAX_ROWS, SYNC_LINE_MAX_BYTES, type SyncRecord } from '@podium/protocol'
import { compressHttpResponse } from '../response-compression'
import * as contentCoding from './content-coding'
import { createContentEncoder, negotiateContentCoding, syncResponseHeaders } from './content-coding'
import { NdjsonEncoder, RowTooLarge } from './ndjson-encoder'
import { pipeSyncBody, SYNC_BODY_HIGH_WATER_MARK } from './pipe-sync-body'

const record: SyncRecord = { type: 'syncError', transferId: 't', reason: 'row-too-large' }
const bytes = new TextEncoder().encode(JSON.stringify(record) + '\n')

describe('sync content coding', () => {
  it.each([
    [null, 'zstd'], ['', 'identity'], ['gzip', 'gzip'], ['zstd, gzip', 'zstd'],
    ['gzip;q=0.5, zstd;q=0.5', 'zstd'], ['*;q=0', 'not-acceptable'],
    ['identity;q=0, gzip', 'gzip'], ['br', 'identity'], ['gzip;q=oops', 'identity'],
    ['gzip;q=0, *;q=1', 'zstd'], ['zstd;q=0,gzip;q=0,*;q=0', 'not-acceptable'],
    ['*;q=0,identity;q=0.2', 'identity'], ['gzip;q=0.4,identity;q=0.8', 'identity'],
    ['GZIP;Q=0.500', 'gzip'], ['gzip;q=1.001', 'identity'],
    ['gzip;q=0,gzip;q=1', 'identity'], ['identity;q=0, br', 'not-acceptable'],
  ])('negotiates %s', (header, expected) => {
    expect(negotiateContentCoding(header)).toBe(expected)
  })

  it('batches by row count and leaves flush empty after emission', () => {
    const encoder = new NdjsonEncoder()
    for (let i = 1; i < SYNC_BATCH_MAX_ROWS; i++) expect(encoder.push(record)).toBeNull()
    expect(new TextDecoder().decode(encoder.push(record)!)).toBe(new TextDecoder().decode(bytes).repeat(SYNC_BATCH_MAX_ROWS))
    expect(encoder.flush()).toBeNull()
    expect(encoder.push(record)).toBeNull()
    expect(encoder.flush()).toEqual(bytes)
  })

  it('counts UTF-8 line bytes and throws a typed refusal without poisoning pending data', () => {
    const encoder = new NdjsonEncoder()
    encoder.push(record)
    expect(() => encoder.push({ ...record, transferId: 'é'.repeat(SYNC_LINE_MAX_BYTES / 2) })).toThrow(RowTooLarge)
    expect(encoder.flush()).toEqual(bytes)
  })

  it.each(['identity', 'gzip', 'zstd'] as const)('sets streaming headers for %s', (coding) => {
    const headers = syncResponseHeaders(coding)
    expect(headers.get('content-encoding')).toBe(coding === 'identity' ? null : coding)
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('vary')).toBe('Accept-Encoding')
    expect(headers.get('cache-control')).toBe('private, no-store')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('never clones or consumes sync responses in the buffering wrapper', async () => {
    const response = new Response('x'.repeat(4096), { headers: { 'content-type': 'application/json' } })
    const clone = vi.spyOn(response, 'clone')
    expect(await compressHttpResponse(new Request('http://localhost/sync/delta', { headers: { 'accept-encoding': 'gzip' } }), response)).toBe(response)
    expect(clone).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
  })

  it('stops source pulls when a consumer stops and returns the iterator on cancellation', async () => {
    const next = vi.fn(async () => ({ done: false as const, value: new Uint8Array(SYNC_BODY_HIGH_WATER_MARK) }))
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
    const abort = vi.fn()
    const body = pipeSyncBody({ [Symbol.asyncIterator]: () => ({ next, return: returned }), abort }, 'identity', new AbortController().signal)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(next).toHaveBeenCalledTimes(1)
    const reader = body.getReader()
    await reader.read()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(next).toHaveBeenCalledTimes(2)
    await reader.cancel('gone')
    expect(abort).toHaveBeenCalledWith('gone')
    expect(returned).toHaveBeenCalledTimes(1)
  })

  it.each(['gzip', 'zstd'] as const)('bounds %s read-ahead even for compressible input', async (coding) => {
    const next = vi.fn(async () => ({ done: false as const, value: new Uint8Array(SYNC_BODY_HIGH_WATER_MARK) }))
    const body = pipeSyncBody({ [Symbol.asyncIterator]: () => ({ next }) }, coding, new AbortController().signal)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // One delivered output slot, one transform in flight, at most one next input.
    const pulls = next.mock.calls.length
    expect(pulls).toBeLessThanOrEqual(3)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(next).toHaveBeenCalledTimes(pulls)
    await body.cancel()
  })

  it('aborts the producer after an injected mid-stream encoder failure', async () => {
    const producer = new AbortController()
    let writes = 0
    const mock = vi.spyOn(contentCoding, 'createContentEncoder').mockImplementation(() => new TransformStream({
      transform(chunk, controller) {
        if (++writes === 2) throw new Error('codec failure')
        controller.enqueue(chunk)
      },
    }))
    try {
      const source = {
        abort: (reason: unknown) => producer.abort(reason),
        async *[Symbol.asyncIterator]() {
          yield bytes
          yield bytes
          yield new TextEncoder().encode('{"type":"syncComplete"}\n')
        },
      }
      const reader = pipeSyncBody(source, 'gzip', new AbortController().signal).getReader()
      expect((await reader.read()).value).toEqual(bytes)
      await expect(reader.read()).rejects.toThrow('codec failure')
      expect(producer.signal.aborted).toBe(true)
    } finally { mock.mockRestore() }
  })

  it('propagates abort while next is pending', async () => {
    const request = new AbortController()
    const producer = new AbortController()
    const source = {
      abort: (reason: unknown) => producer.abort(reason),
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => producer.signal.addEventListener('abort', () => resolve(), { once: true }))
        yield bytes
      },
    }
    const reader = pipeSyncBody(source, 'gzip', request.signal).getReader()
    const reading = reader.read()
    request.abort(new Error('disconnected'))
    await expect(reading).rejects.toThrow('disconnected')
    expect(producer.signal.aborted).toBe(true)
  })

  it.each(['gzip', 'zstd'] as const)('fails %s rather than switching coding after a write error', async (coding) => {
    const encoder = createContentEncoder(coding)!
    const reader = encoder.readable.getReader()
    const writer = encoder.writable.getWriter()
    const reading = reader.read()
    await writer.write(bytes)
    expect((await reading).done).toBe(false)
    await writer.abort(new Error('encoder failed'))
    await expect((async () => { while (!(await reader.read()).done) {} })()).rejects.toThrow('encoder failed')
  })
})
