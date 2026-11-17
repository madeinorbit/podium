/**
 * The blob store contract against a REAL S3-compatible bucket [POD-6963 F2].
 *
 * Opt-in and credentialed: `bun run test:live:s3` with the bucket in the
 * environment, never the default gate (`*.live.test.ts` is excluded from every
 * unit lane). Credentials come from the environment only:
 *
 *   PODIUM_FILE_STORAGE_ENDPOINT, PODIUM_FILE_STORAGE_BUCKET,
 *   PODIUM_FILE_STORAGE_REGION, PODIUM_FILE_STORAGE_ACCESS_KEY_ID,
 *   PODIUM_FILE_STORAGE_SECRET_ACCESS_KEY
 *
 * Every test writes under its own `live-<run>-<n>/` prefix and deletes it after.
 * The provider-behaviour block prints one `S3 PROVIDER` line per question the
 * design left to F2: If-None-Match and If-Match on PUT, a range past the end,
 * and listing order.
 */

import { randomUUID } from 'node:crypto'
import { asWorkspaceId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { blobKey, keySegment } from './key'
import { S3BlobStorage } from './s3'
import { bodyText, bytes, describeBlobStoreContract, listKeys } from './testing/contract'
import { BlobConditionFailed } from './types'

const VARIABLES = [
  'PODIUM_FILE_STORAGE_ENDPOINT',
  'PODIUM_FILE_STORAGE_BUCKET',
  'PODIUM_FILE_STORAGE_REGION',
  'PODIUM_FILE_STORAGE_ACCESS_KEY_ID',
  'PODIUM_FILE_STORAGE_SECRET_ACCESS_KEY',
] as const

const missing = VARIABLES.filter((name) => !process.env[name])
if (missing.length > 0) {
  // The lane is explicit, so an unconfigured run is a failure, never a quiet skip.
  throw new Error(`the live S3 lane needs ${missing.join(', ')} in the environment`)
}

const storage = new S3BlobStorage({
  endpoint: process.env.PODIUM_FILE_STORAGE_ENDPOINT as string,
  bucket: process.env.PODIUM_FILE_STORAGE_BUCKET as string,
  region: process.env.PODIUM_FILE_STORAGE_REGION as string,
  accessKeyId: process.env.PODIUM_FILE_STORAGE_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.PODIUM_FILE_STORAGE_SECRET_ACCESS_KEY as string,
})

const run = randomUUID().slice(0, 8)
let next = 0
const freshWorkspace = () => asWorkspaceId(`live-${run}-${next++}`)

async function removeWorkspace(workspace: string): Promise<void> {
  let continuationToken: string | undefined
  do {
    const page = await storage.bun.list({
      prefix: `${workspace}/`,
      maxKeys: 1000,
      ...(continuationToken === undefined ? {} : { continuationToken }),
    })
    for (const entry of page.contents ?? []) await storage.bun.delete(entry.key)
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
  } while (continuationToken !== undefined)
}

describeBlobStoreContract('s3 (live bucket)', async () => {
  const workspace = freshWorkspace()
  return {
    store: storage.forWorkspace(workspace),
    dispose: () => removeWorkspace(workspace),
  }
})

async function refused(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise
    return false
  } catch (error) {
    if (error instanceof BlobConditionFailed) return true
    throw error
  }
}

describe('s3 provider behaviour', () => {
  const report = (question: string, answer: string) => {
    console.log(`S3 PROVIDER ${question}: ${answer}`)
  }

  it('honours If-None-Match: * on PUT', async () => {
    const workspace = freshWorkspace()
    const store = storage.forWorkspace(workspace)
    try {
      await store.put(blobKey('q/absent'), bytes('first'), { ifAbsent: true })
      const second = await refused(
        store.put(blobKey('q/absent'), bytes('second'), { ifAbsent: true }),
      )
      const kept = await bodyText(await store.get(blobKey('q/absent')))
      report(
        'If-None-Match on PUT',
        second && kept === 'first'
          ? 'honoured (412)'
          : `IGNORED (body now ${JSON.stringify(kept)})`,
      )
      expect(second).toBe(true)
      expect(kept).toBe('first')
    } finally {
      await removeWorkspace(workspace)
    }
  })

  it('honours If-Match on PUT', async () => {
    const workspace = freshWorkspace()
    const store = storage.forWorkspace(workspace)
    try {
      const v1 = await store.put(blobKey('q/match'), bytes('v1'))
      const v2 = await store.put(blobKey('q/match'), bytes('v2'), { ifMatch: v1.etag })
      const stale = await refused(store.put(blobKey('q/match'), bytes('v3'), { ifMatch: v1.etag }))
      const onMissing = await refused(
        store.put(blobKey('q/none'), bytes('x'), { ifMatch: v2.etag }),
      )
      const kept = await bodyText(await store.get(blobKey('q/match')))
      report(
        'If-Match on PUT',
        stale && onMissing && kept === 'v2'
          ? 'honoured (stale etag refused, missing key refused)'
          : `NOT HONOURED (stale refused=${stale}, missing refused=${onMissing}, body ${JSON.stringify(kept)})`,
      )
      expect([stale, onMissing, kept]).toEqual([true, true, 'v2'])
    } finally {
      await removeWorkspace(workspace)
    }
  })

  it('answers a range past the end', async () => {
    const workspace = freshWorkspace()
    const store = storage.forWorkspace(workspace)
    try {
      await store.put(blobKey('q/range'), bytes('0123456789'))
      const url = storage.bun.presign(`${workspace}/q/range`, { method: 'GET', expiresIn: 60 })
      const raw = await fetch(url, { headers: { range: 'bytes=10-19' } })
      await raw.body?.cancel()
      const past = await store.get(blobKey('q/range'), { offset: 10, length: 10 })
      const over = await store.get(blobKey('q/range'), { offset: 8, length: 10 })
      const pastText = await bodyText(past)
      const overText = await bodyText(over)
      report(
        'range past the end',
        `raw status ${raw.status} (content-range ${raw.headers.get('content-range') ?? 'none'}); adapter: empty body, size ${past?.size}; overlapping range returns ${JSON.stringify(overText)}`,
      )
      expect([past?.size, pastText, over?.size, overText]).toEqual([10, '', 10, '89'])
    } finally {
      await removeWorkspace(workspace)
    }
  })

  it('lists in ascending byte order', async () => {
    const workspace = freshWorkspace()
    const store = storage.forWorkspace(workspace)
    try {
      const keys = [
        'l/a_e',
        'l/0',
        'l/a/c',
        'l/B',
        `l/${keySegment('native id/with spaces')}`,
        'l/a.d',
        'l/a-b',
        'l/a/cc/d',
      ]
      for (const key of keys) await store.put(blobKey(key), bytes(key))
      const listed = await listKeys(store, blobKey('l'))
      const expected = [...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      report(
        'list order',
        JSON.stringify(listed) === JSON.stringify(expected)
          ? 'ascending byte order'
          : `NOT byte order: ${JSON.stringify(listed)}`,
      )
      expect(listed).toEqual(expected)
    } finally {
      await removeWorkspace(workspace)
    }
  })
})
