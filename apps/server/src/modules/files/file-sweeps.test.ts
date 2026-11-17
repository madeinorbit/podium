/**
 * THE HOURLY FILE SWEEPS (POD-6963 design 2.9, POD-7057).
 *
 * The composer-upload sweep and the CLI-transfer sweep are queries over
 * `pending_uploads` and `artifact_uploads` plus deletes: neither walks the blob
 * store to find work, so their cost follows the rows, not the bucket. The
 * composer sweep lists nothing; the transfer sweep lists only the staging
 * prefix of each upload its query found (a chunk's offset is the client's, so
 * the row cannot name the keys). Both are safe to
 * run twice, one after the other or side by side (two server processes before
 * POD-6962's leases), and after a crash between a blob delete and its row
 * delete. The job runner is the seam POD-6962 replaces.
 */

import { randomUUID } from 'node:crypto'
import { type BlobKey, type BlobStore, LOCAL_WORKSPACE_ID } from '@podium/blob-store'
import { MemoryBlobStorage, MemoryBucket } from '@podium/blob-store/memory'
import { ArtifactUploadPacket, asArtifactId, asIssueId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { type ArtifactRpc, IssueArtifactStore } from '../issues/artifact-store'
import { PENDING_UPLOAD_MAX_AGE_MS, PendingUploadStore } from '../issues/pending-uploads'
import { fileStorageJobs } from './file-jobs'

const DAY = PENDING_UPLOAD_MAX_AGE_MS
const HOUR = 60 * 60 * 1000
const ALICE = asUserId('user:alice')
const ISSUE = asIssueId('iss_1')

const noRpc: ArtifactRpc = {
  readAsset: async () => ({ ok: false, error: 'unused' }),
  listDir: async (input) => ({ ok: false, path: input.root, entries: [] }),
}

const opened: SessionStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

async function fixture() {
  let clock = 0
  const store = await openTestStore(':memory:')
  opened.push(store)
  const bucket = new MemoryBucket({ now: () => clock })
  const inner = new MemoryBlobStorage(bucket).forWorkspace(LOCAL_WORKSPACE_ID)
  // Every call passes through; `list` is watched, because a sweep must not walk the store.
  const list = vi.fn((prefix: BlobKey) => inner.list(prefix))
  const files: BlobStore = {
    put: (...args) => inner.put(...args),
    get: (...args) => inner.get(...args),
    head: (...args) => inner.head(...args),
    delete: (...args) => inner.delete(...args),
    copy: (...args) => inner.copy(...args),
    list,
    conditionalWrites: inner.conditionalWrites,
  }
  const pending = new PendingUploadStore({ files, records: store.pendingUploads, now: () => clock })
  const artifacts = new IssueArtifactStore({
    files,
    uploads: store.artifactUploads,
    rpc: noRpc,
    now: () => clock,
  })
  const names = () => bucket.names().map((name) => name.slice(`${LOCAL_WORKSPACE_ID}/`.length))
  return {
    store,
    inner,
    pending,
    artifacts,
    list,
    names,
    at(ms: number) {
      clock = ms
    },
    async upload(name: string) {
      return await pending.put({
        ownerUserId: ALICE,
        filename: name,
        mediaType: 'image/png',
        bytes: new Uint8Array([1]),
      })
    },
    /** A CLI transfer that was begun and sent one chunk, then never committed. */
    async transfer() {
      const uploadId = randomUUID()
      const begin = ArtifactUploadPacket.parse({
        action: 'begin',
        uploadId,
        path: 'report',
        entry: 'r.md',
        files: [{ path: 'r.md', size: 2 }],
      })
      await artifacts.transfer(ISSUE, begin)
      await artifacts.transfer(
        ISSUE,
        ArtifactUploadPacket.parse({
          action: 'chunk',
          uploadId,
          file: 'r.md',
          offset: 0,
          dataBase64: Buffer.from('x').toString('base64'),
        }),
      )
      return uploadId
    },
  }
}

describe('the hourly file sweeps', () => {
  it('remove day-old uploads and transfers found by their rows, without walking the store', async () => {
    const f = await fixture()
    const oldUpload = await f.upload('old.png')
    const oldTransfer = await f.transfer()
    f.at(DAY / 2)
    const freshUpload = await f.upload('fresh.png')
    const freshTransfer = await f.transfer()
    f.at(DAY + HOUR)

    expect(await f.pending.sweep()).toBe(1)
    await f.artifacts.sweepUploads()

    expect(f.list.mock.calls.map(([prefix]) => prefix)).toEqual([
      `artifacts/.uploads/${ISSUE}/${oldTransfer}`,
    ])
    expect(await f.store.pendingUploads.get(oldUpload.id)).toBeUndefined()
    expect(await f.store.artifactUploads.get(ISSUE, oldTransfer)).toBeUndefined()
    expect(f.names()).toEqual([
      `artifacts/.uploads/${ISSUE}/${freshTransfer}/0000/000000000000`,
      `pending-uploads/${freshUpload.id}/file/fresh.png`,
    ])
  })

  it('are safe to run twice, one after the other and side by side', async () => {
    const f = await fixture()
    for (let n = 0; n < 5; n++) {
      await f.upload(`u${n}.png`)
      await f.transfer()
    }
    const claimed = await f.upload('claimed.png')
    await f.pending.markClaimed(claimed.id, { issueId: ISSUE, artifactId: asArtifactId('a1') })
    f.at(DAY + HOUR)

    const results = await Promise.all([
      f.pending.sweep(),
      f.pending.sweep(),
      f.artifacts.sweepUploads(),
      f.artifacts.sweepUploads(),
    ])
    // Each row is counted by whichever pass deleted it, and no pass failed.
    expect((results[0] as number) + (results[1] as number)).toBeGreaterThanOrEqual(6)
    expect(f.names()).toEqual([])
    expect(await f.store.pendingUploads.page('', 100)).toEqual([])
    expect(await f.store.artifactUploads.page(undefined, 100)).toEqual([])

    expect(await f.pending.sweep()).toBe(0)
    await f.artifacts.sweepUploads()
    expect(f.names()).toEqual([])
  })

  it('finish a row whose bytes a crashed pass already deleted', async () => {
    const f = await fixture()
    const upload = await f.upload('a.png')
    const transfer = await f.transfer()
    f.at(DAY + HOUR)
    // The crashed pass: blobs gone, rows still there.
    for (const name of f.names()) await f.inner.delete(name as BlobKey)

    expect(await f.pending.sweep()).toBe(1)
    await f.artifacts.sweepUploads()
    expect(await f.store.pendingUploads.get(upload.id)).toBeUndefined()
    expect(await f.store.artifactUploads.get(ISSUE, transfer)).toBeUndefined()
  })
})

describe('the file storage job runner (the seam POD-6962 replaces)', () => {
  it('skips a start while the same job runs, and runs other jobs beside it', async () => {
    const jobs = fileStorageJobs()
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = jobs.run('orphan-audit', () => blocked)
    expect(await jobs.run('orphan-audit', async () => {})).toBe(false)
    expect(await jobs.run('pending-upload-sweep', async () => {})).toBe(true)
    release()
    expect(await first).toBe(true)
    expect(await jobs.run('orphan-audit', async () => {})).toBe(true)
  })

  it('rejects with a job’s failure and lets the job start again', async () => {
    const jobs = fileStorageJobs()
    await expect(
      jobs.run('artifact-upload-sweep', async () => {
        throw new Error('fenced')
      }),
    ).rejects.toThrow('fenced')
    expect(await jobs.run('artifact-upload-sweep', async () => {})).toBe(true)
  })
})
