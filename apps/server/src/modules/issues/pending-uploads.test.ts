import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobStore } from '@podium/blob-store'
import { LocalBlobStorage } from '@podium/blob-store/local'
import { MemoryBlobStorage } from '@podium/blob-store/memory'
import { asArtifactId, asIssueId, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { PortableStateFence } from '../server-transfer/portable-fence'
import { PENDING_UPLOAD_MAX_AGE_MS, PendingUploadStore } from './pending-uploads'

/**
 * COMPOSER UPLOADS ON THE BLOB STORE (POD-2148; POD-6963 design 2.5, POD-7055).
 *
 * The bytes are one object per upload, the record a `pending_uploads` row. Run on
 * the state directory a self-hosted server uses and on an in-memory bucket with
 * object-store semantics.
 */

const ALICE = asUserId('user:alice')
const ISSUE = asIssueId('iss_1')
const OTHER = asIssueId('iss_2')

let db: SessionStore
const roots: string[] = []
beforeEach(async () => {
  db = await openTestStore(':memory:')
})
afterEach(async () => {
  await db.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'podium-pending-'))
  roots.push(root)
  return root
}

const file = (filename: string, bytes = [1, 2, 3]) => ({
  ownerUserId: ALICE,
  filename,
  mediaType: 'image/png',
  bytes: new Uint8Array(bytes),
})

describe.each([
  ['local disk', 'local'],
  ['object store', 'memory'],
] as const)('pending uploads on %s', (_label, backend) => {
  let root: string
  let files: BlobStore
  let now: number
  let pending: PendingUploadStore
  beforeEach(async () => {
    root = await stateDir()
    now = 1_000
    files =
      backend === 'local'
        ? new LocalBlobStorage({ stateDir: root }).forWorkspace(SELF_HOSTED_WORKSPACE_ID)
        : new MemoryBlobStorage().forWorkspace(SELF_HOSTED_WORKSPACE_ID)
    pending = new PendingUploadStore({ files, records: db.pendingUploads, now: () => now })
  })

  it('holds the bytes under a fresh UUID, owned by the uploader, with its record in a row', async () => {
    const meta = await pending.put(file('../shot.png'))
    expect(meta).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      ownerUserId: ALICE,
      filename: '../shot.png',
      entry: 'shot.png',
      mediaType: 'image/png',
      size: 3,
      createdAt: 1_000,
    })
    expect(await pending.meta(meta.id)).toEqual(meta)
    expect(await db.pendingUploads.get(meta.id)).toEqual(meta)
    expect(await pending.bytes(meta)).toEqual(new Uint8Array([1, 2, 3]))
    expect(pending.fileKey(meta)).toBe(`pending-uploads/${meta.id}/file/shot.png`)
    if (backend === 'local') {
      // Today's path under the state directory, and no meta.json beside it.
      const dir = join(root, 'pending-uploads', meta.id)
      expect(await readdir(dir)).toEqual(['file'])
      expect(new Uint8Array(await readFile(join(dir, 'file', 'shot.png')))).toEqual(
        new Uint8Array([1, 2, 3]),
      )
    }
    // Only upload ids are ever looked up.
    expect(await pending.meta('../etc')).toBeUndefined()
  })

  it('stores a name that is not a plain key segment under its encoded form', async () => {
    const meta = await pending.put(file('Screen Shot 1.png'))
    expect(meta.entry).toBe('Screen Shot 1.png')
    expect(pending.fileKey(meta)).toMatch(new RegExp(`^pending-uploads/${meta.id}/file/~`))
    expect(await pending.bytes(meta)).toEqual(new Uint8Array([1, 2, 3]))
    // One the key cannot hold is refused, and nothing is recorded.
    await expect(pending.put(file(`${'é'.repeat(100)}.png`))).rejects.toThrow('too long to store')
    expect(await db.pendingUploads.createdBefore(Number.MAX_SAFE_INTEGER, 10)).toHaveLength(1)
  })

  it('records the first claim only; a later one answers the claim already made', async () => {
    const meta = await pending.put(file('a.png'))
    const mine = { issueId: ISSUE, artifactId: asArtifactId('a1') }
    expect(await pending.markClaimed(meta.id, mine)).toEqual(mine)
    expect(
      await pending.markClaimed(meta.id, { issueId: OTHER, artifactId: asArtifactId('a2') }),
    ).toEqual(mine)
    expect(await pending.meta(meta.id)).toMatchObject({ claimed: mine })
    expect((await pending.claimedBy(ISSUE)).map((m) => m.id)).toEqual([meta.id])
    expect(await pending.claimedBy(OTHER)).toEqual([])
    // Another issue cannot clear this issue's claim; this issue can.
    await pending.markUnclaimed(meta.id, OTHER)
    expect((await pending.meta(meta.id))?.claimed).toEqual(mine)
    await pending.markUnclaimed(meta.id, ISSUE)
    expect(await pending.meta(meta.id)).not.toHaveProperty('claimed')
    expect(await pending.claimedBy(ISSUE)).toEqual([])
    // An upload that is gone has no claim to record.
    expect(await pending.markClaimed('00000000-0000-4000-8000-000000000000', mine)).toBeUndefined()
  })

  it('sweeps uploads older than a day, claimed ones included, and keeps fresh ones', async () => {
    const old = await pending.put(file('a.png', [1]))
    const claimed = await pending.put(file('b.png', [2]))
    await pending.markClaimed(claimed.id, { issueId: ISSUE, artifactId: asArtifactId('a1') })
    now = PENDING_UPLOAD_MAX_AGE_MS / 2
    const fresh = await pending.put(file('c.png', [3]))
    now = PENDING_UPLOAD_MAX_AGE_MS + 1_001

    expect(await pending.sweep()).toBe(2)
    expect(await pending.meta(old.id)).toBeUndefined()
    expect(await pending.meta(claimed.id)).toBeUndefined()
    expect(await pending.bytes(old)).toBeUndefined()
    // A claimed upload's leftover source goes with its row.
    expect(await pending.bytes(claimed)).toBeUndefined()
    expect(await pending.bytes(fresh)).toEqual(new Uint8Array([3]))
    if (backend === 'local')
      expect(await readdir(join(root, 'pending-uploads'))).toEqual([fresh.id])
    expect(await pending.sweep()).toBe(0)
  })

  it('discards only the owner’s unclaimed upload', async () => {
    const meta = await pending.put(file('a.png'))
    expect(await pending.discard(meta.id, asUserId('user:bob'))).toBe(false)
    expect(await pending.discard(meta.id, ALICE)).toBe(true)
    expect(await pending.meta(meta.id)).toBeUndefined()
    expect(await pending.bytes(meta)).toBeUndefined()

    const claimed = await pending.put(file('b.png'))
    await pending.markClaimed(claimed.id, { issueId: ISSUE, artifactId: asArtifactId('a1') })
    expect(await pending.discard(claimed.id, ALICE)).toBe(false)
    expect(await pending.meta(claimed.id)).toMatchObject({ claimed: { issueId: ISSUE } })
  })
})

describe('pending uploads under a server-transfer fence', () => {
  it('refuses a new upload, records nothing, and skips the sweep', async () => {
    const fence = new PortableStateFence()
    let now = 0
    const root = await stateDir()
    const pending = new PendingUploadStore({
      files: new LocalBlobStorage({ stateDir: root, fence }).forWorkspace(SELF_HOSTED_WORKSPACE_ID),
      records: db.pendingUploads,
      now: () => now,
    })
    const kept = await pending.put(file('a.png'))
    await fence.acquire()
    try {
      await expect(pending.put(file('b.png'))).rejects.toThrow('portable state is fenced')
      expect(await db.pendingUploads.createdBefore(Number.MAX_SAFE_INTEGER, 10)).toEqual([
        { id: kept.id, entry: 'a.png' },
      ])
      now = PENDING_UPLOAD_MAX_AGE_MS + 1
      expect(await pending.sweep()).toBe(0)
      expect(await readdir(join(root, 'pending-uploads'))).toEqual([kept.id])
      expect(await pending.meta(kept.id)).toEqual(kept)
    } finally {
      fence.release()
    }
  })
})
