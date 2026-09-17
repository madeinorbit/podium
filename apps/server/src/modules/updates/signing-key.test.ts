import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { importUpdateSigningKey, mintUpdateSigningKey, rotateUpdateSigningKey } from '@podium/runtime/update-signing-key'
import { acceptsUpdateKeyRotation } from '@podium/runtime/update-key-trust'
import { asMachineId } from '@podium/model'
import { SessionStore } from '../../store'
import { authenticateDaemon, type EnrollmentHost } from '../machines/enrollment'
import { readOrCreateDevArtifactToken, readOrCreateUpdateSigningKey } from './signing-key'

const dirs: string[] = []
const databases: SqlDatabase[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-update-key-'))
  dirs.push(dir)
  return dir
}
function database(): SqlDatabase {
  const db = openDatabase(':memory:')
  db.exec('CREATE TABLE server_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  databases.push(db)
  return db
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('server update signing key', () => {
  it('imports the original pair through store upgrade, removes both files, and verifies with the paired pin after restart', async () => {
    const dir = temp()
    const original = mintUpdateSigningKey()
    writeFileSync(join(dir, 'update-signing-key.json'), JSON.stringify(original))
    writeFileSync(join(dir, 'update-signing-key.pub'), original.publicKey)
    const store = await SessionStore.open(join(dir, 'podium.db'))
    await store.close()
    expect(existsSync(join(dir, 'update-signing-key.json'))).toBe(false)
    expect(existsSync(join(dir, 'update-signing-key.pub'))).toBe(false)
    const restarted = await SessionStore.open(join(dir, 'podium.db'))
    expect(readOrCreateUpdateSigningKey(dir, { allowCreate: false })).toEqual(original)
    await restarted.checkpointForTransfer()
    await restarted.close()
    const target = temp()
    copyFileSync(join(dir, 'podium.db'), join(target, 'podium.db'))
    const migrated = readOrCreateUpdateSigningKey(target, { allowCreate: false })
    expect(existsSync(join(target, 'update-signing-key.json'))).toBe(false)
    expect(existsSync(join(target, 'update-signing-key.pub'))).toBe(false)
    expect(migrated).toEqual(original)
    const body = Buffer.from('bundle-bytes')
    const privateKey = createPrivateKey({ key: Buffer.from(migrated.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    const pinnedPublicKey = createPublicKey({ key: Buffer.from(original.publicKey, 'base64'), format: 'der', type: 'spki' })
    expect(verify(null, body, pinnedPublicKey, sign(null, body, privateKey))).toBe(true)
  })

  it('delivers the preserved rotation chain on authenticated hello after migration and another real rotation', async () => {
    const dir = temp()
    const source = database()
    const original = readOrCreateUpdateSigningKey(source)
    const beforeMigration = rotateUpdateSigningKey(source)
    writeFileSync(join(dir, 'update-signing-key.json'), JSON.stringify(beforeMigration))
    writeFileSync(join(dir, 'update-signing-key.pub'), original.publicKey)
    const db = database()
    importUpdateSigningKey(db, dir)
    const rotated = rotateUpdateSigningKey(db)
    const machineId = asMachineId('pinned-machine')
    const host = {
      deps: {
        store: { machines: {
          getMachineByToken: async () => ({ id: machineId }),
          getMachine: async () => ({ id: machineId, name: 'joined', revokedAt: null }),
        } },
        updatePubkey: () => readOrCreateUpdateSigningKey(db).publicKey,
        updateKeyRotations: () => readOrCreateUpdateSigningKey(db).rotations,
      },
    } as unknown as EnrollmentHost
    const hello = await authenticateDaemon(host, {
      type: 'hello', machineId, token: 'paired-credential', hostname: 'joined',
    }, { verifyOnly: true })
    expect(hello.ok).toBe(true)
    if (!hello.ok) throw new Error(hello.reason)
    expect(hello.updatePubkey).toBe(rotated.publicKey)
    expect(hello.updateKeyRotations).toHaveLength(2)
    expect(acceptsUpdateKeyRotation(original.publicKey, hello.updatePubkey!, hello.updateKeyRotations!)).toBe(true)
  })

  it('mints once in the database without writing key files', () => {
    const db = database()
    const first = readOrCreateUpdateSigningKey(db)
    expect(readOrCreateUpdateSigningKey(db)).toEqual(first)
  })

  it('refuses malformed legacy material without marking it imported or deleting it', () => {
    const dir = temp()
    const db = database()
    writeFileSync(join(dir, 'update-signing-key.json'), '{"privateKey":"bad","publicKey":"bad"}')
    expect(() => importUpdateSigningKey(db, dir)).toThrow(/invalid persisted update signing key/)
    expect(existsSync(join(dir, 'update-signing-key.json'))).toBe(true)
    expect(db.prepare('SELECT * FROM server_secrets').all()).toEqual([])
    expect(db.prepare('SELECT * FROM meta').all()).toEqual([])
  })

  it('rejects a valid pair with an unrelated legacy anchor without changing database authority', () => {
    const dir = temp()
    const db = database()
    writeFileSync(join(dir, 'update-signing-key.json'), JSON.stringify(mintUpdateSigningKey()))
    writeFileSync(join(dir, 'update-signing-key.pub'), mintUpdateSigningKey().publicKey)
    expect(() => importUpdateSigningKey(db, dir)).toThrow(/does not match its public anchor/)
    expect(db.prepare('SELECT * FROM server_secrets').all()).toEqual([])
    expect(db.prepare('SELECT * FROM meta').all()).toEqual([])
    expect(existsSync(join(dir, 'update-signing-key.json'))).toBe(true)
  })

  it('retains a lone anchor as evidence that a missing key must not be replaced', () => {
    const dir = temp()
    const db = database()
    writeFileSync(join(dir, 'update-signing-key.pub'), mintUpdateSigningKey().publicKey)
    importUpdateSigningKey(db, dir)
    expect(() => readOrCreateUpdateSigningKey(db)).toThrow(/refusing to mint a replacement/)
    expect(existsSync(join(dir, 'update-signing-key.pub'))).toBe(false)
    expect(readOrCreateUpdateSigningKey(db, { confirmNoPins: true }).publicKey).toBeTruthy()
  })

  it('does not re-import a stale file after the one-time migration', () => {
    const dir = temp()
    const db = database()
    const original = mintUpdateSigningKey()
    writeFileSync(join(dir, 'update-signing-key.json'), JSON.stringify(original))
    importUpdateSigningKey(db, dir)
    const rotated = rotateUpdateSigningKey(db)
    writeFileSync(join(dir, 'update-signing-key.json'), JSON.stringify(original))
    importUpdateSigningKey(db, dir)
    expect(readOrCreateUpdateSigningKey(db)).toEqual(rotated)
  })

  it('finishes file removal after an interrupted post-commit cleanup without importing again', () => {
    const dir = temp()
    const db = database()
    const key = readOrCreateUpdateSigningKey(db)
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('update_signing_key_imported_v1', 'files-pending')
    writeFileSync(join(dir, 'update-signing-key.json'), 'stale bytes')
    importUpdateSigningKey(db, dir)
    expect(existsSync(join(dir, 'update-signing-key.json'))).toBe(false)
    expect(readOrCreateUpdateSigningKey(db)).toEqual(key)
  })

  it('mints the artifact token once and keeps the manifest credential across restart', () => {
    const dir = temp()
    const first = readOrCreateDevArtifactToken(dir)
    expect(readOrCreateDevArtifactToken(dir)).toBe(first)
    expect(statSync(join(dir, 'dev-artifact-token')).mode & 0o777).toBe(0o600)
  })

  it('refuses a malformed artifact token instead of invalidating published URLs', () => {
    const dir = temp()
    writeFileSync(join(dir, 'dev-artifact-token'), 'rotated-or-corrupt\n')
    expect(() => readOrCreateDevArtifactToken(dir)).toThrow(/invalid persisted development artifact token/)
  })
})
