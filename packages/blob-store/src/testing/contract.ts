/**
 * The blob store contract [POD-6963 design 2.1]: one suite every adapter
 * passes. contract.test.ts runs it against the local and in-memory adapters;
 * F2 runs it against the S3 adapter in its opt-in lane.
 *
 * It checks only what the interface promises on every backend. Adapter-specific
 * behaviour (durable fsyncs, temp files, the fence, local etags) is tested next
 * to the adapter.
 */

import { describe, expect, it } from 'vitest'
import { type BlobKey, blobKey, InvalidBlobKey, keySegment, padNumber } from '../key'
import { BlobConditionFailed, type BlobGetResult, BlobNotFound, type BlobStore } from '../types'

export interface BlobStoreFixture {
  store: BlobStore
  dispose?: () => Promise<void>
  /**
   * The adapter mints a new etag on every put, even of identical bytes (local
   * and memory). False for object stores whose ETag is the MD5 of the bytes (S3,
   * R2): there the etag changes when the bytes change.
   */
  etagPerPut?: boolean
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const bytes = (text: string): Uint8Array => encoder.encode(text)

/** Every byte of a body, as text. */
export async function readText(body: ReadableStream<Uint8Array>): Promise<string> {
  return decoder.decode(await new Response(body).arrayBuffer())
}

/** Every byte of a get result's body, as text; a missing object fails the test. */
export async function bodyText(got: BlobGetResult | undefined): Promise<string> {
  if (got === undefined) throw new Error('expected an object, got undefined')
  return readText(got.body)
}

export async function listKeys(store: BlobStore, prefix: BlobKey): Promise<string[]> {
  const keys: string[] = []
  for await (const entry of store.list(prefix)) keys.push(entry.key)
  return keys
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(bytes(chunk))
      controller.close()
    },
  })
}

async function conditionOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof BlobConditionFailed) return error.condition
    throw error
  }
}

export function describeBlobStoreContract(
  name: string,
  setup: () => Promise<BlobStoreFixture>,
): void {
  describe(`blob store contract: ${name}`, () => {
    const withStore =
      (test: (store: BlobStore, fixture: BlobStoreFixture) => Promise<void>) => async () => {
        const fixture = await setup()
        try {
          await test(fixture.store, fixture)
        } finally {
          await fixture.dispose?.()
        }
      }
    const k = blobKey

    it(
      'honours conditional writes',
      withStore(async (store) => {
        expect(store.conditionalWrites).toBe(true)
      }),
    )

    it(
      'puts and gets bytes, with one etag across put, head and get',
      withStore(async (store) => {
        const put = await store.put(k('artifacts/i1/a1/index.html'), bytes('hello'), {
          contentType: 'text/html',
        })
        expect(put.size).toBe(5)
        const head = await store.head(k('artifacts/i1/a1/index.html'))
        expect(head).toEqual({ size: 5, etag: put.etag })
        const got = await store.get(k('artifacts/i1/a1/index.html'))
        expect(got?.size).toBe(5)
        expect(got?.etag).toBe(put.etag)
        expect(await bodyText(got)).toBe('hello')
      }),
    )

    it(
      'takes a stream body',
      withStore(async (store) => {
        const put = await store.put(k('s/x'), streamOf('ab', '', 'cde'))
        expect(put.size).toBe(5)
        expect(await bodyText(await store.get(k('s/x')))).toBe('abcde')
      }),
    )

    it(
      'stores an empty object',
      withStore(async (store) => {
        expect((await store.put(k('e/x'), new Uint8Array())).size).toBe(0)
        const got = await store.get(k('e/x'))
        expect(got?.size).toBe(0)
        expect(await bodyText(got)).toBe('')
      }),
    )

    it(
      'returns undefined for a missing key',
      withStore(async (store) => {
        expect(await store.get(k('missing/x'))).toBeUndefined()
        expect(await store.get(k('missing/x'), { offset: 0, length: 4 })).toBeUndefined()
        expect(await store.head(k('missing/x'))).toBeUndefined()
      }),
    )

    it(
      'replaces the whole object and changes the etag when the bytes change',
      withStore(async (store, fixture) => {
        const first = await store.put(k('r/x'), bytes('a longer first body'))
        const second = await store.put(k('r/x'), bytes('short'))
        const third = await store.put(k('r/x'), bytes('short'))
        expect(second.etag).not.toBe(first.etag)
        if (fixture.etagPerPut) expect(third.etag).not.toBe(second.etag)
        const got = await store.get(k('r/x'))
        expect(got?.size).toBe(5)
        expect(got?.etag).toBe(third.etag)
        expect(await bodyText(got)).toBe('short')
      }),
    )

    it(
      'clips ranges to the object and always reports its whole size',
      withStore(async (store) => {
        await store.put(k('g/x'), bytes('0123456789'))
        const read = async (offset: number, length: number) => {
          const got = await store.get(k('g/x'), { offset, length })
          return { size: got?.size, text: await bodyText(got) }
        }
        expect(await read(2, 3)).toEqual({ size: 10, text: '234' })
        expect(await read(0, 10)).toEqual({ size: 10, text: '0123456789' })
        expect(await read(7, 100)).toEqual({ size: 10, text: '789' })
        expect(await read(9, 0)).toEqual({ size: 10, text: '' })
        expect(await read(10, 5)).toEqual({ size: 10, text: '' })
        expect(await read(25, 5)).toEqual({ size: 10, text: '' })
      }),
    )

    it(
      'clips a range on an empty object',
      withStore(async (store) => {
        await store.put(k('g/empty'), new Uint8Array())
        const got = await store.get(k('g/empty'), { offset: 0, length: 8 })
        expect(got?.size).toBe(0)
        expect(await bodyText(got)).toBe('')
      }),
    )

    it(
      'refuses a negative or fractional range',
      withStore(async (store) => {
        await store.put(k('g/y'), bytes('abc'))
        await expect(store.get(k('g/y'), { offset: -1, length: 1 })).rejects.toThrow(RangeError)
        await expect(store.get(k('g/y'), { offset: 0, length: -1 })).rejects.toThrow(RangeError)
        await expect(store.get(k('g/y'), { offset: 0.5, length: 1 })).rejects.toThrow(RangeError)
      }),
    )

    it(
      'deletes idempotently',
      withStore(async (store) => {
        await store.put(k('d/x'), bytes('x'))
        await store.delete(k('d/x'))
        expect(await store.head(k('d/x'))).toBeUndefined()
        await store.delete(k('d/x'))
        await store.delete(k('d/never'))
      }),
    )

    it(
      'deletes with either durability, idempotently',
      withStore(async (store) => {
        await store.put(k('d/durable'), bytes('x'))
        await store.put(k('d/relaxed'), bytes('y'))
        await store.delete(k('d/durable'), { durable: true })
        await store.delete(k('d/relaxed'), { durable: false })
        expect(await store.head(k('d/durable'))).toBeUndefined()
        expect(await store.head(k('d/relaxed'))).toBeUndefined()
        await store.delete(k('d/durable'), { durable: true })
      }),
    )

    it(
      'lists every key under the prefix in ascending byte order',
      withStore(async (store) => {
        const encoded = keySegment('native id/with spaces')
        const inside = [
          'p/a_e',
          'p/0',
          'p/a/c',
          'p/B',
          `p/${encoded}`,
          'p/a.d',
          'p/a-b',
          'p/a/cc/d/e',
        ]
        // Byte order: '-' 0x2d < '.' 0x2e < '/' 0x2f < '0' < 'B' < '_' 0x5f < 'a' < '~' 0x7e,
        // so the keys under directory `p/a` sort between `p/a.d` and `p/a_e`.
        const expected = [
          'p/0',
          'p/B',
          'p/a-b',
          'p/a.d',
          'p/a/c',
          'p/a/cc/d/e',
          'p/a_e',
          `p/${encoded}`,
        ]
        const outside = ['p-other/x', 'pp/x', 'q/p/x']
        for (const key of [...inside, ...outside]) await store.put(k(key), bytes(key))
        expect(await listKeys(store, k('p'))).toEqual(expected)
        expect(await listKeys(store, k('p/a'))).toEqual(['p/a/c', 'p/a/cc/d/e'])
      }),
    )

    it(
      'lists sizes, padded numbers in numeric order, and nothing for a missing prefix',
      withStore(async (store) => {
        for (const n of [10, 2, 100, 1])
          await store.put(k(`n/${padNumber(n, 6)}`), bytes('x'.repeat(n)))
        const entries: Array<{ key: string; size: number }> = []
        for await (const entry of store.list(k('n')))
          entries.push({ key: entry.key, size: entry.size })
        expect(entries).toEqual([
          { key: 'n/000001', size: 1 },
          { key: 'n/000002', size: 2 },
          { key: 'n/000010', size: 10 },
          { key: 'n/000100', size: 100 },
        ])
        expect(await listKeys(store, k('nothing/here'))).toEqual([])
        expect(await listKeys(store, k('n/000001'))).toEqual([])
      }),
    )

    it(
      'does not list a deleted key',
      withStore(async (store) => {
        await store.put(k('l/a'), bytes('a'))
        await store.put(k('l/b'), bytes('b'))
        await store.delete(k('l/a'))
        expect(await listKeys(store, k('l'))).toEqual(['l/b'])
      }),
    )

    it(
      'ifAbsent writes a new key and refuses an existing one',
      withStore(async (store) => {
        await store.put(k('c/x'), bytes('first'), { ifAbsent: true })
        expect(await conditionOf(store.put(k('c/x'), bytes('second'), { ifAbsent: true }))).toBe(
          'ifAbsent',
        )
        expect(await bodyText(await store.get(k('c/x')))).toBe('first')
      }),
    )

    it(
      'ifMatch replaces only the version it names',
      withStore(async (store) => {
        const first = await store.put(k('c/y'), bytes('v1'))
        const second = await store.put(k('c/y'), bytes('v2'), { ifMatch: first.etag })
        expect(second.etag).not.toBe(first.etag)
        expect(await conditionOf(store.put(k('c/y'), bytes('v3'), { ifMatch: first.etag }))).toBe(
          'ifMatch',
        )
        expect(await bodyText(await store.get(k('c/y')))).toBe('v2')
        expect(await conditionOf(store.put(k('c/none'), bytes('v'), { ifMatch: first.etag }))).toBe(
          'ifMatch',
        )
        expect(await store.head(k('c/none'))).toBeUndefined()
      }),
    )

    it(
      'lets exactly one of two racing conditional puts win',
      withStore(async (store) => {
        const absent = await Promise.all(
          ['a', 'b'].map((v) =>
            conditionOf(store.put(k('race/absent'), bytes(v), { ifAbsent: true })),
          ),
        )
        expect(absent.filter((c) => c === undefined)).toHaveLength(1)
        const base = await store.put(k('race/match'), bytes('base'))
        const match = await Promise.all(
          ['a', 'b'].map((v) =>
            conditionOf(store.put(k('race/match'), bytes(v), { ifMatch: base.etag })),
          ),
        )
        expect(match.filter((c) => c === undefined)).toHaveLength(1)
        expect(match.filter((c) => c === 'ifMatch')).toHaveLength(1)
      }),
    )

    it(
      'copies an object and replaces the target',
      withStore(async (store) => {
        await store.put(k('cp/src'), bytes('source bytes'))
        await store.put(k('cp/dst'), bytes('old target, longer than the source'))
        await store.copy(k('cp/src'), k('cp/dst'))
        await store.copy(k('cp/src'), k('cp/new/deep/dst'))
        expect(await bodyText(await store.get(k('cp/dst')))).toBe('source bytes')
        expect(await bodyText(await store.get(k('cp/new/deep/dst')))).toBe('source bytes')
        expect(await bodyText(await store.get(k('cp/src')))).toBe('source bytes')
      }),
    )

    it(
      'refuses to copy a missing source',
      withStore(async (store) => {
        await expect(store.copy(k('cp/missing'), k('cp/to'))).rejects.toBeInstanceOf(BlobNotFound)
        expect(await store.head(k('cp/to'))).toBeUndefined()
      }),
    )

    it(
      'refuses a key the validator did not mint',
      withStore(async (store) => {
        const raw = (value: string) => value as BlobKey
        await expect(store.put(raw('../escape'), bytes('x'))).rejects.toBeInstanceOf(InvalidBlobKey)
        await expect(store.get(raw('/abs'))).rejects.toBeInstanceOf(InvalidBlobKey)
        await expect(store.head(raw('a//b'))).rejects.toBeInstanceOf(InvalidBlobKey)
        await expect(store.delete(raw('a/./b'))).rejects.toBeInstanceOf(InvalidBlobKey)
      }),
    )
  })
}
