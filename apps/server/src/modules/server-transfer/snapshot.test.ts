import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalServerTransferManifest, type ServerTransferManifest } from '@podium/protocol'
import {
  createPortableSnapshot,
  isSafeRelativePath,
  serverTransferManifestDigest,
} from './snapshot'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('portable server snapshot', () => {
  it('canonicalizes sorted entries and excludes the digest from its own hash', () => {
    const body: ServerTransferManifest = {
      formatVersion: 1 as const,
      transferId: '00000000-0000-4000-8000-000000000001',
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
    const first = serverTransferManifestDigest(body)
    const second = serverTransferManifestDigest({ ...body, files: [...body.files].reverse() })

    expect(first).toBe(second)
    expect(canonicalServerTransferManifest(body)).not.toContain(first)
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
