import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bumpInstallationGeneration,
  INSTALLATION_FILE,
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  mintInstallationIdentity,
} from '@podium/runtime/installation-identity'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  importInstallationIdentity,
  INSTALLATION_IMPORT_MARKER,
} from './installation-identity-import'
import { openTestStore } from './test-support/open-test-store'

const roots: string[] = []
const databases: SqlDatabase[] = []
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'installation-import-'))
  roots.push(root)
  return root
}
function database() {
  const db = openDatabase(':memory:')
  databases.push(db)
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE server_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);`)
  return db
}
function value(db: SqlDatabase, table: 'meta' | 'server_secrets', key: string) {
  return (
    db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value: string } | undefined
  )?.value
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('installation identity import', () => {
  it('imports unchanged identity, splits the private key, retires the file, and reopens from the database', async () => {
    const root = directory()
    const identity = { ...mintInstallationIdentity(), generation: 7 }
    writeFileSync(join(root, INSTALLATION_FILE), JSON.stringify(identity))
    let store = await openTestStore(join(root, 'podium.db'))
    try {
      expect(await store.secrets.installationIdentity()).toEqual(identity)
      expect(existsSync(join(root, INSTALLATION_FILE))).toBe(false)
      expect((await store.secrets.presence()).map((row) => row.key)).not.toContain(
        INSTALLATION_PRIVATE_KEY,
      )
    } finally {
      await store.close()
    }
    const db = openDatabase(join(root, 'podium.db'))
    try {
      expect(JSON.parse(value(db, 'meta', INSTALLATION_META_KEY)!)).toEqual({
        version: 1,
        installationId: identity.installationId,
        publicKey: identity.publicKey,
        generation: 7,
        createdAt: identity.createdAt,
      })
      expect(value(db, 'server_secrets', INSTALLATION_PRIVATE_KEY)).toBe(identity.privateKey)
    } finally {
      db.close()
    }
    store = await openTestStore(join(root, 'podium.db'))
    try {
      expect(await store.secrets.installationIdentity()).toEqual(identity)
    } finally {
      await store.close()
    }
  })

  it('mints independently for each database, once, without a new state-root file', () => {
    const root = directory()
    const first = database()
    const second = database()
    importInstallationIdentity(first, root)
    const original = value(first, 'meta', INSTALLATION_META_KEY)
    importInstallationIdentity(first, root)
    importInstallationIdentity(second, root)
    expect(value(first, 'meta', INSTALLATION_META_KEY)).toBe(original)
    expect(value(second, 'meta', INSTALLATION_META_KEY)).not.toBe(original)
    expect(JSON.parse(original!).generation).toBe(1)
    expect(existsSync(join(root, INSTALLATION_FILE))).toBe(false)
  })

  it.each([
    '{',
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      ...mintInstallationIdentity(),
      publicKey: mintInstallationIdentity().publicKey,
    }),
  ])('refuses corrupt legacy material without minting or deleting it', (raw) => {
    const root = directory()
    const db = database()
    writeFileSync(join(root, INSTALLATION_FILE), raw)
    expect(() => importInstallationIdentity(db, root)).toThrow(/invalid persisted installation/)
    expect(value(db, 'meta', INSTALLATION_META_KEY)).toBeUndefined()
    expect(value(db, 'meta', INSTALLATION_IMPORT_MARKER)).toBeUndefined()
    expect(value(db, 'server_secrets', INSTALLATION_PRIVATE_KEY)).toBeUndefined()
    expect(readFileSync(join(root, INSTALLATION_FILE), 'utf8')).toBe(raw)
  })

  it('rolls back both rows on a database failure and retains the source for retry', () => {
    const root = directory()
    const db = database()
    const identity = mintInstallationIdentity()
    writeFileSync(join(root, INSTALLATION_FILE), JSON.stringify(identity))
    db.exec(
      "CREATE TRIGGER refuse_key BEFORE INSERT ON server_secrets BEGIN SELECT RAISE(ABORT, 'key failed'); END",
    )
    expect(() => importInstallationIdentity(db, root)).toThrow('key failed')
    expect(value(db, 'meta', INSTALLATION_META_KEY)).toBeUndefined()
    expect(value(db, 'meta', INSTALLATION_IMPORT_MARKER)).toBeUndefined()
    expect(existsSync(join(root, INSTALLATION_FILE))).toBe(true)
    db.exec('DROP TRIGGER refuse_key')
    importInstallationIdentity(db, root)
    expect(value(db, 'server_secrets', INSTALLATION_PRIVATE_KEY)).toBe(identity.privateKey)
  })

  it.each([
    true,
    false,
  ])('resumes post-commit cleanup with legacy file present=%s without importing again', (present) => {
    const root = directory()
    const db = database()
    importInstallationIdentity(db, root)
    const original = value(db, 'meta', INSTALLATION_META_KEY)
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      'pending-cleanup',
      INSTALLATION_IMPORT_MARKER,
    )
    if (present) writeFileSync(join(root, INSTALLATION_FILE), 'old file no longer authoritative')
    importInstallationIdentity(db, root)
    expect(value(db, 'meta', INSTALLATION_META_KEY)).toBe(original)
    expect(value(db, 'meta', INSTALLATION_IMPORT_MARKER)).toBe('complete')
    expect(existsSync(join(root, INSTALLATION_FILE))).toBe(false)
  })

  it('does not resurrect a completed import or remint a damaged database', () => {
    const root = directory()
    const db = database()
    importInstallationIdentity(db, root)
    db.prepare('DELETE FROM meta WHERE key = ?').run(INSTALLATION_META_KEY)
    writeFileSync(join(root, INSTALLATION_FILE), JSON.stringify(mintInstallationIdentity()))
    importInstallationIdentity(db, root)
    expect(value(db, 'meta', INSTALLATION_META_KEY)).toBeUndefined()
  })

  it('advances only the database generation and preserves identity and key', () => {
    const db = database()
    bumpInstallationGeneration(db)
    importInstallationIdentity(db)
    const before = JSON.parse(value(db, 'meta', INSTALLATION_META_KEY)!)
    const key = value(db, 'server_secrets', INSTALLATION_PRIVATE_KEY)
    bumpInstallationGeneration(db)
    expect(JSON.parse(value(db, 'meta', INSTALLATION_META_KEY)!)).toEqual({
      ...before,
      generation: 2,
    })
    expect(value(db, 'server_secrets', INSTALLATION_PRIVATE_KEY)).toBe(key)
  })
})
