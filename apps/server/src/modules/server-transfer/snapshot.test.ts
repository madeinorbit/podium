import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { canonicalServerTransferManifest, type ServerTransferManifest } from '@podium/protocol'
import {
  bumpInstallationGeneration,
  mintInstallationIdentity,
} from '@podium/runtime/installation-identity'
import { openDatabase } from '@podium/runtime/sqlite'
import {
  mintUpdateSigningKey,
  readOrCreateUpdateSigningKey,
} from '@podium/runtime/update-signing-key'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import {
  exclusiveLockFromAnotherProcess,
  openFromAnotherProcess,
} from '../../test-support/sqlite-locks'
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

  it('carries held composer uploads, meta and bytes (POD-2148)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-pending-transfer-'))
    roots.push(root)
    const held = join(root, 'pending-uploads', '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b')
    await mkdir(join(held, 'file'), { recursive: true })
    await writeFile(join(held, 'meta.json'), '{}')
    await writeFile(join(held, 'file', 'shot.png'), 'PNG')
    expect(isSafeRelativePath('pending-uploads/x/meta.json')).toBe(true)
    const source = await openTestStore(join(root, 'podium.db'))
    try {
      const snapshot = await createPortableSnapshot({
        stateRoot: root,
        packageDir: join(root, '.server-transfer', 'snapshot'),
        operationId: 'operation-pending',
        transferId: 'transfer-pending',
        sourceInstanceId: 'instance-source',
        sourceMachineId: asMachineId('source'),
        targetMachineId: asMachineId('target'),
        sourceFeedId: 'feed',
        sourceFeedEpoch: 'epoch',
        sourceApplicationVersion: 'test',
        sourceSchemaVersion: 'test',
        snapshotDatabase: (destination) => source.snapshotForTransfer(destination),
      })
      expect(snapshot.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([
          'pending-uploads/3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b/meta.json',
          'pending-uploads/3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b/file/shot.png',
        ]),
      )
    } finally {
      await source.close()
    }
  })

  it("snapshots podium.db without dropping the live store's SQLite locks [POD-6263]", async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-transfer-locks-'))
    roots.push(root)
    const dbPath = join(root, 'podium.db')
    const source = await openTestStore(dbPath)
    try {
      const snapshot = await createPortableSnapshot({
        stateRoot: root,
        packageDir: join(root, '.server-transfer', 'snapshot'),
        operationId: 'operation-locks',
        transferId: 'transfer-locks',
        sourceInstanceId: 'instance-source',
        sourceMachineId: asMachineId('source'),
        targetMachineId: asMachineId('target'),
        sourceFeedId: 'feed',
        sourceFeedEpoch: 'epoch',
        sourceApplicationVersion: 'test',
        sourceSchemaVersion: 'test',
        snapshotDatabase: (destination) => source.snapshotForTransfer(destination),
      })
      expect(snapshot.files.map((file) => file.path)).toContain('podium.db')

      // The live store must still own its locks: another process can neither
      // take the database exclusively nor, after an ordinary read, delete the
      // sidecars when it closes.
      expect(exclusiveLockFromAnotherProcess(dbPath)).toBe('refused')
      openFromAnotherProcess(dbPath)
      expect(existsSync(`${dbPath}-wal`)).toBe(true)
      expect(existsSync(`${dbPath}-shm`)).toBe(true)
      expect(await source.secrets.installationIdentity()).toBeDefined()
    } finally {
      await source.close()
    }
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
        snapshotDatabase: (destination) => source.snapshotForTransfer(destination),
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

  it('refuses symlinks before writing any snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-transfer-manifest-'))
    roots.push(root)
    await writeFile(join(root, 'podium.db'), 'db')
    await writeFile(join(root, 'enrollment.ledger'), 'ledger')
    await writeFile(join(root, 'update-signing-key.json'), 'server-key')
    await mkdir(join(root, 'transcripts'))
    await symlink(join(root, 'podium.db'), join(root, 'transcripts', 'linked.db'))
    const snapshotDatabase = vi.fn(async () => undefined)

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
        snapshotDatabase,
      }),
    ).rejects.toThrow(/unsafe file/)
    expect(snapshotDatabase).not.toHaveBeenCalled()
  })
})
