import { mintUpdateSigningKey, readOrCreateUpdateSigningKey } from '@podium/runtime/update-signing-key'
import { existsSync } from 'node:fs'
import {
  bumpInstallationGeneration,
  mintInstallationIdentity,
} from '@podium/runtime/installation-identity'
import { openDatabase } from '@podium/runtime/sqlite'
import { openTestStore } from '../../test-support/open-test-store'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { canonicalServerTransferManifest, type ServerTransferManifest } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
      operationId: 'operation-1',
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

  it('carries installation identities inside podium.db, never as separate files', () => {
    expect(isSafeRelativePath('installation.json')).toBe(false)
    expect(isSafeRelativePath('podium.db')).toBe(true)
    expect(isSafeRelativePath('update-signing-key.json')).toBe(false)
    for (const hostFile of ['machine.id', 'daemon.secret', 'config.json']) {
      expect(isSafeRelativePath(hostFile)).toBe(false)
    }
  })

  it('transfers an upgraded identity with the database and advances only the target generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-upgraded-transfer-'))
    roots.push(root)
    const identity = { ...mintInstallationIdentity(), generation: 12 }
    await writeFile(join(root, 'installation.json'), JSON.stringify(identity))
    const signingKey = mintUpdateSigningKey()
    await writeFile(join(root, 'update-signing-key.json'), JSON.stringify(signingKey))
    const source = await openTestStore(join(root, 'podium.db'))
    const targetRoot = join(root, '.server-transfer', 'snapshot')
    try {
      expect(await source.secrets.installationIdentity()).toEqual(identity)
      expect(existsSync(join(root, 'installation.json'))).toBe(false)
      const snapshot = await createPortableSnapshot({
        stateRoot: root,
        packageDir: targetRoot,
        operationId: 'operation-upgraded',
        transferId: 'transfer-upgraded',
        sourceInstanceId: 'instance-source',
        sourceMachineId: asMachineId('source'),
        targetMachineId: asMachineId('target'),
        sourceFeedId: 'feed',
        sourceFeedEpoch: 'epoch',
        sourceApplicationVersion: 'test',
        sourceSchemaVersion: 'test',
        checkpoint: () => source.checkpointForTransfer(),
      })
      expect(snapshot.files.map((file) => file.path)).toContain('podium.db')
      expect(snapshot.files.map((file) => file.path)).not.toContain('installation.json')
      expect(snapshot.files.map((file) => file.path)).not.toContain('update-signing-key.json')
      expect(readOrCreateUpdateSigningKey(targetRoot, { allowCreate: false })).toEqual(signingKey)
      const promotedDb = openDatabase(join(targetRoot, 'podium.db'))
      try {
        bumpInstallationGeneration(promotedDb)
      } finally {
        promotedDb.close()
      }
      const target = await openTestStore(join(targetRoot, 'podium.db'))
      try {
        expect(await target.secrets.installationIdentity()).toEqual({ ...identity, generation: 13 })
        expect(existsSync(join(targetRoot, 'installation.json'))).toBe(false)
      } finally {
        await target.close()
      }
      expect(await source.secrets.installationIdentity()).toEqual(identity)
    } finally {
      await source.close()
    }
  })

  it('checkpoints before snapshot and refuses symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-transfer-manifest-'))
    roots.push(root)
    await writeFile(join(root, 'podium.db'), 'db')
    await writeFile(join(root, 'enrollment.ledger'), 'ledger')
    await writeFile(join(root, 'update-signing-key.json'), 'server-key')
    await mkdir(join(root, 'transcripts'))
    await symlink(join(root, 'podium.db'), join(root, 'transcripts', 'linked.db'))
    const checkpoint = vi.fn()

    await expect(
      createPortableSnapshot({
        stateRoot: root,
        packageDir: join(root, '.server-transfer', 'snapshot'),
        operationId: 'operation-1',
        transferId: 'transfer-1',
        sourceInstanceId: 'instance-1',
        sourceMachineId: asMachineId('source-1'),
        targetMachineId: asMachineId('target-1'),
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
