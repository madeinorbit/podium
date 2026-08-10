import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalManifestBody,
  createPortableSnapshot,
  isSafeRelativePath,
  manifestWithDigest,
} from './manifest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('portable server snapshot', () => {
  it('canonicalizes sorted entries and excludes the digest from its own hash', () => {
    const body = {
      formatVersion: 1 as const,
      transferId: 'transfer-1',
      sourceInstanceId: 'instance-1',
      sourceMachineId: 'source-1',
      targetMachineId: 'target-1',
      sourceFeedId: 'feed-1',
      sourceFeedEpoch: 'epoch-1',
      appVersion: 'test',
      schemaVersion: 'schema-1',
      packageBytes: 2,
      files: [
        { path: 'transcripts/z', size: 1, mode: 0o600, sha256: 'b'.repeat(64) },
        { path: 'podium.db', size: 1, mode: 0o600, sha256: 'a'.repeat(64) },
      ],
    }
    const first = manifestWithDigest(body)
    const second = manifestWithDigest({ ...body, files: [...body.files].reverse() })

    expect(first.digest).toBe(second.digest)
    expect(first.files.map((entry) => entry.path)).toEqual(['podium.db', 'transcripts/z'])
    expect(canonicalManifestBody(body)).not.toContain(first.digest)
  })

  it.each([
    '../podium.db',
    '/podium.db',
    'transcripts/../machine.id',
    'transcripts\\secret',
    'machine.id',
    'uploads',
  ])('rejects unsafe or non-portable path %s', (path) => {
    expect(isSafeRelativePath(path)).toBe(false)
  })

  it('checkpoints before snapshot and refuses symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-transfer-manifest-'))
    roots.push(root)
    await writeFile(join(root, 'podium.db'), 'db')
    await writeFile(join(root, 'enrollment.ledger'), 'ledger')
    await mkdir(join(root, 'transcripts'))
    await symlink(join(root, 'podium.db'), join(root, 'transcripts', 'linked.db'))
    const checkpoint = vi.fn()

    await expect(
      createPortableSnapshot({
        stateRoot: root,
        packageDir: join(root, '.server-transfer', 'snapshot'),
        transferId: 'transfer-1',
        sourceInstanceId: 'instance-1',
        sourceMachineId: 'source-1',
        targetMachineId: 'target-1',
        sourceFeedId: 'feed-1',
        sourceFeedEpoch: 'epoch-1',
        sourceApplicationVersion: 'test',
        sourceSchemaVersion: 'schema-1',
        checkpoint,
      }),
    ).rejects.toThrow(/unsafe file/)
    expect(checkpoint).toHaveBeenCalledOnce()
  })
})
