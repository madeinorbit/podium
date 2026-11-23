import { asWorkspaceId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { blobKey } from './key'
import { S3BlobStorage, type S3BlobStorageOptions } from './s3'
import { S3Fake, type S3FakeOptions } from './s3-fake'
import { bodyText, bytes, describeBlobStoreContract, listKeys, readText } from './testing/contract'
import { BlobConditionFailed } from './types'

const MiB = 1024 * 1024

async function withFake(
  test: (fake: S3Fake, storage: S3BlobStorage) => Promise<void>,
  fakeOptions: S3FakeOptions = {},
  storageOptions: Partial<S3BlobStorageOptions> = {},
): Promise<void> {
  const fake = new S3Fake(fakeOptions)
  const endpoint = fake.start()
  try {
    await test(fake, storageFor(fake, endpoint, storageOptions))
  } finally {
    await fake.stop()
  }
}

function storageFor(
  fake: S3Fake,
  endpoint: string,
  options: Partial<S3BlobStorageOptions> = {},
): S3BlobStorage {
  return new S3BlobStorage({
    endpoint,
    bucket: fake.bucket,
    region: 'auto',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    ...options,
  })
}

function streamOfSizes(...sizes: number[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = sizes[index]
      if (size === undefined) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(size).fill(65 + (index % 26)))
      index += 1
    },
  })
}

function failingStream(chunks: number, chunkSize: number): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.error(new Error('source failed'))
        return
      }
      controller.enqueue(new Uint8Array(chunkSize))
      sent += 1
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

describeBlobStoreContract('s3 (in-process fake)', async () => {
  // A small page size, so every list in the contract also crosses page boundaries.
  const fake = new S3Fake({ maxPageSize: 3 })
  const endpoint = fake.start()
  return {
    store: storageFor(fake, endpoint).forWorkspace(asWorkspaceId('ws-contract')),
    dispose: () => fake.stop(),
  }
})

describe('s3 adapter', () => {
  it('keeps each workspace under its own prefix in one bucket', () =>
    withFake(async (fake, storage) => {
      const a = storage.forWorkspace(asWorkspaceId('ws-a'))
      const b = storage.forWorkspace(asWorkspaceId('ws-b'))
      const key = blobKey('artifacts/i1/a1/index.html')
      await a.put(key, bytes('from a'))
      await b.put(key, bytes('from b'))
      expect(fake.names()).toEqual([
        'ws-a/artifacts/i1/a1/index.html',
        'ws-b/artifacts/i1/a1/index.html',
      ])
      expect(await bodyText(await a.get(key))).toBe('from a')
      await a.delete(key)
      expect(await a.head(key)).toBeUndefined()
      expect(await listKeys(b, blobKey('artifacts'))).toEqual([key])
      // `local` is accepted too: a self-hosted operator may point at a bucket.
      await storage.forWorkspace(asWorkspaceId('local')).put(key, bytes('self-hosted'))
      expect(fake.names()).toContain('local/artifacts/i1/a1/index.html')
    }))

  it('refuses a workspace id that is not one plain key segment', () =>
    withFake(async (_fake, storage) => {
      for (const id of ['', 'a/b', '..', '.', '~abc', 'has space']) {
        expect(() => storage.forWorkspace(asWorkspaceId(id)), id).toThrow(TypeError)
      }
    }))

  it('maps the provider’s 416 for a range past the end to an empty body with the real size', () =>
    withFake(async (fake, storage) => {
      const store = storage.forWorkspace(asWorkspaceId('ws'))
      const put = await store.put(blobKey('g/x'), bytes('0123456789'))
      const got = await store.get(blobKey('g/x'), { offset: 10, length: 4 })
      expect(got?.size).toBe(10)
      expect(got?.etag).toBe(put.etag)
      expect(await bodyText(got)).toBe('')
      const ranged = fake.requests.filter((r) => r.method === 'GET' && r.headers.range)
      expect(ranged.map((r) => [r.headers.range, r.status])).toEqual([['bytes=10-13', 416]])
    }))

  it('sends a range that runs past the end and returns the bytes up to it', () =>
    withFake(async (fake, storage) => {
      const store = storage.forWorkspace(asWorkspaceId('ws'))
      await store.put(blobKey('g/x'), bytes('0123456789'))
      const got = await store.get(blobKey('g/x'), { offset: 6, length: 100 })
      expect({ size: got?.size, text: await bodyText(got) }).toEqual({ size: 10, text: '6789' })
      const last = fake.requests.at(-1)
      expect([last?.headers.range, last?.status]).toEqual(['bytes=6-105', 206])
    }))

  it('streams a large put as a multipart upload and returns the stored etag', () =>
    withFake(
      async (fake, storage) => {
        const store = storage.forWorkspace(asWorkspaceId('ws'))
        const put = await store.put(blobKey('big/x'), streamOfSizes(3 * MiB, 3 * MiB, 1 * MiB), {
          contentType: 'application/x-test',
        })
        expect(put.size).toBe(7 * MiB)
        const stored = fake.objects.get('ws/big/x')
        expect(stored?.bytes.byteLength).toBe(7 * MiB)
        expect(stored?.contentType).toBe('application/x-test')
        expect(put.etag).toBe(stored?.etag)
        expect(put.etag).toMatch(/-2"$/)
        const calls = fake.requests.filter((r) => r.name === 'ws/big/x')
        expect(calls.filter((r) => r.method === 'POST' && 'uploads' in r.query)).toHaveLength(1)
        expect(calls.filter((r) => r.method === 'PUT' && r.query.partNumber)).toHaveLength(2)
        const got = await store.get(blobKey('big/x'), { offset: 3 * MiB - 2, length: 4 })
        expect(await readText((got as NonNullable<typeof got>).body)).toBe('AABB')
      },
      {},
      { partSize: 5 * MiB },
    ))

  it('sends a stream that fits in one part as a single PUT', () =>
    withFake(async (fake, storage) => {
      const store = storage.forWorkspace(asWorkspaceId('ws'))
      const put = await store.put(blobKey('s/x'), streamOfSizes(10, 20))
      expect(put.size).toBe(30)
      const calls = fake.requests.filter((r) => r.name === 'ws/s/x' && r.method !== 'HEAD')
      expect(calls.map((r) => r.method)).toEqual(['PUT'])
      expect(fake.uploads.size).toBe(0)
    }))

  it('leaves no object when a streamed source fails, and no open multipart upload', () =>
    withFake(
      async (fake, storage) => {
        const store = storage.forWorkspace(asWorkspaceId('ws'))
        await expect(store.put(blobKey('f/big'), failingStream(12, 1 * MiB))).rejects.toThrow(
          'source failed',
        )
        await expect(store.put(blobKey('f/small'), failingStream(1, 1024))).rejects.toThrow(
          'source failed',
        )
        expect(fake.names()).toEqual([])
        expect(fake.uploads.size).toBe(0)
      },
      {},
      { partSize: 5 * MiB },
    ))

  it('sends conditional puts with a stream body as one conditional PutObject', () =>
    withFake(async (fake, storage) => {
      const store = storage.forWorkspace(asWorkspaceId('ws'))
      await store.put(blobKey('c/x'), streamOfSizes(5, 5), { ifAbsent: true })
      expect(
        await conditionOf(store.put(blobKey('c/x'), streamOfSizes(1), { ifAbsent: true })),
      ).toBe('ifAbsent')
      const puts = fake.requests.filter((r) => r.name === 'ws/c/x' && r.method === 'PUT')
      expect(puts.map((r) => [r.headers['if-none-match'], r.status])).toEqual([
        ['*', 200],
        ['*', 412],
      ])
    }))

  it('maps If-Match on a missing key (404) and a conflicting write (409) to a refused condition', () =>
    withFake(async (fake, storage) => {
      const store = storage.forWorkspace(asWorkspaceId('ws'))
      const put = await store.put(blobKey('c/y'), bytes('v1'))
      expect(
        await conditionOf(store.put(blobKey('c/none'), bytes('v'), { ifMatch: put.etag })),
      ).toBe('ifMatch')
      fake.conflictNextConditionalPuts = 1
      expect(await conditionOf(store.put(blobKey('c/y'), bytes('v2'), { ifMatch: put.etag }))).toBe(
        'ifMatch',
      )
      expect(await bodyText(await store.get(blobKey('c/y')))).toBe('v1')
      expect(
        fake.requests
          .filter((r) => r.method === 'PUT' && r.headers['if-match'])
          .map((r) => r.status),
      ).toEqual([404, 409])
    }))

  it('returns the same etag for identical bytes, as S3 and R2 do', () =>
    withFake(async (_fake, storage) => {
      const store = storage.forWorkspace(asWorkspaceId('ws'))
      const first = await store.put(blobKey('e/x'), bytes('same'))
      const second = await store.put(blobKey('e/x'), bytes('same'))
      expect(second.etag).toBe(first.etag)
      expect((await store.head(blobKey('e/x')))?.etag).toBe(first.etag)
    }))

  it('refuses conditional puts without sending them when the bucket has no conditional writes', () =>
    withFake(
      async (fake, storage) => {
        const store = storage.forWorkspace(asWorkspaceId('ws'))
        expect(store.conditionalWrites).toBe(false)
        await expect(store.put(blobKey('n/x'), bytes('x'), { ifAbsent: true })).rejects.toThrow(
          /without conditional writes/,
        )
        await expect(store.put(blobKey('n/x'), bytes('x'), { ifMatch: '"e"' })).rejects.toThrow(
          /without conditional writes/,
        )
        expect(fake.requests).toEqual([])
        await store.put(blobKey('n/x'), bytes('unconditional'))
        expect(fake.names()).toEqual(['ws/n/x'])
      },
      { honourConditions: false },
      { conditionalWrites: false },
    ))

  it('pages through a listing with continuation tokens, in key order', () =>
    withFake(
      async (fake, storage) => {
        const store = storage.forWorkspace(asWorkspaceId('ws'))
        const keys = ['p/e', 'p/a', 'p/d', 'p/c', 'p/b']
        for (const key of keys) await store.put(blobKey(key), bytes(key))
        expect(await listKeys(store, blobKey('p'))).toEqual(['p/a', 'p/b', 'p/c', 'p/d', 'p/e'])
        const lists = fake.requests.filter((r) => r.query['list-type'] === '2')
        expect(lists).toHaveLength(3)
        expect(lists.map((r) => r.query.prefix)).toEqual(['ws/p/', 'ws/p/', 'ws/p/'])
      },
      { maxPageSize: 2 },
    ))

  it('refuses a provider listing that is not in ascending key order', () =>
    withFake(
      async (_fake, storage) => {
        const store = storage.forWorkspace(asWorkspaceId('ws'))
        await store.put(blobKey('o/a'), bytes('a'))
        await store.put(blobKey('o/b'), bytes('b'))
        await expect(listKeys(store, blobKey('o'))).rejects.toThrow(/not in ascending key order/)
      },
      { listDescending: true },
    ))

  it('copies server side, keeping the content type', () =>
    withFake(async (fake, storage) => {
      const store = storage.forWorkspace(asWorkspaceId('ws'))
      await store.put(blobKey('cp/src'), bytes('<p>hi</p>'), { contentType: 'text/html' })
      await store.copy(blobKey('cp/src'), blobKey('cp/dst'))
      expect(fake.objects.get('ws/cp/dst')?.contentType).toBe('text/html')
      const copy = fake.requests.find((r) => r.headers['x-amz-copy-source'] !== undefined)
      expect(copy?.headers['x-amz-copy-source']).toBe(`${fake.bucket}/ws/cp/src`)
      expect(copy?.name).toBe('ws/cp/dst')
    }))

  it('reports a missing bucket on get instead of a missing key', () =>
    withFake(async (fake) => {
      const store = storageFor(fake, fake.endpoint, { bucket: 'no-such-bucket' }).forWorkspace(
        asWorkspaceId('ws'),
      )
      await expect(store.get(blobKey('k/x'))).rejects.toMatchObject({ name: 'NoSuchBucket' })
    }))

  it('validates its options', () =>
    withFake(async (fake) => {
      const endpoint = fake.endpoint
      expect(() => storageFor(fake, endpoint, { bucket: '' })).toThrow(/bucket is empty/)
      expect(() => storageFor(fake, endpoint, { partSize: 1024 })).toThrow(RangeError)
      expect(() => storageFor(fake, endpoint, { listPageSize: 0 })).toThrow(RangeError)
      expect(() => storageFor(fake, endpoint, { listPageSize: 1001 })).toThrow(RangeError)
    }))
})
