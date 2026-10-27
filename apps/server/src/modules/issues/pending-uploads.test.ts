import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asArtifactId, asIssueId, asUserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { PortableStateFence } from '../server-transfer/portable-fence'
import { PENDING_UPLOAD_MAX_AGE_MS, PendingUploadStore } from './pending-uploads'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store(now: () => number, fence?: PortableStateFence) {
  const root = await mkdtemp(join(tmpdir(), 'podium-pending-'))
  roots.push(root)
  return { root, pending: new PendingUploadStore(root, fence, now) }
}

const ALICE = asUserId('user:alice')

describe('pending uploads (POD-2148)', () => {
  it('holds the bytes under a fresh UUID, owned by the uploader', async () => {
    const { pending } = await store(() => 1_000)
    const meta = await pending.put({
      ownerUserId: ALICE,
      filename: '../shot.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    })
    expect(meta).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      ownerUserId: ALICE,
      filename: '../shot.png',
      entry: 'shot.png',
      size: 3,
      createdAt: 1_000,
    })
    expect(await pending.meta(meta.id)).toEqual(meta)
    expect(new Uint8Array(await readFile(join(pending.fileDir(meta.id), 'shot.png')))).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    // Only upload ids are ever looked up.
    expect(await pending.meta('../etc')).toBeUndefined()
  })

  it('sweeps uploads older than a day, claimed ones included, and keeps fresh ones', async () => {
    let now = 0
    const { root, pending } = await store(() => now)
    const old = await pending.put({
      ownerUserId: ALICE,
      filename: 'a.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([1]),
    })
    const claimed = await pending.put({
      ownerUserId: ALICE,
      filename: 'b.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([2]),
    })
    await pending.markClaimed(claimed.id, {
      issueId: asIssueId('iss_1'),
      artifactId: asArtifactId('a1'),
    })
    now = PENDING_UPLOAD_MAX_AGE_MS / 2
    const fresh = await pending.put({
      ownerUserId: ALICE,
      filename: 'c.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([3]),
    })
    now = PENDING_UPLOAD_MAX_AGE_MS + 1

    expect(await pending.sweep()).toBe(2)
    expect(await readdir(root)).toEqual([fresh.id])
    expect(await pending.meta(old.id)).toBeUndefined()
  })

  it('a server-transfer fence refuses a new upload and skips the sweep', async () => {
    const fence = new PortableStateFence()
    let now = 0
    const { root, pending } = await store(() => now, fence)
    const kept = await pending.put({
      ownerUserId: ALICE,
      filename: 'a.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([1]),
    })
    await fence.acquire()
    await expect(
      pending.put({
        ownerUserId: ALICE,
        filename: 'b.png',
        mediaType: 'image/png',
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow('portable state is fenced')
    now = PENDING_UPLOAD_MAX_AGE_MS + 1
    expect(await pending.sweep()).toBe(0)
    expect(await readdir(root)).toEqual([kept.id])
    fence.release()
  })

  it('discards only the owner’s unclaimed upload', async () => {
    const { pending } = await store(() => 0)
    const meta = await pending.put({
      ownerUserId: ALICE,
      filename: 'a.png',
      mediaType: 'image/png',
      bytes: new Uint8Array([1]),
    })
    expect(await pending.discard(meta.id, asUserId('user:bob'))).toBe(false)
    expect(await pending.discard(meta.id, ALICE)).toBe(true)
    expect(await pending.meta(meta.id)).toBeUndefined()
  })
})
