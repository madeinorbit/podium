/**
 * THE FINGERPRINT IS A KEYED MAC, PROVED AS A PROPERTY OF THE FUNCTION.
 *
 * "We used an HMAC" is a claim about source text, and a reviewer reading
 * `createHmac` is reading the same source text. The two assertions that make
 * this file worth having are claims about the OUTPUT:
 *
 *   1. it is NOT the bare digest of the material (any spelling of one), and
 *   2. it CHANGES when the server key changes.
 *
 * Together those are unsatisfiable by a digest, which is the construction
 * POD-418 forbade. A test that only checked "same input, same output" would pass
 * against `sha256(value).slice(0, 16)` — the exact thing being ruled out.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FINGERPRINT_BYTES,
  secretFingerprint,
  secretPresence,
} from './secret-fingerprint'

import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { importFingerprintKey, FINGERPRINT_KEY_FILE, FINGERPRINT_SECRET_KEY, FINGERPRINT_IMPORT_MARKER } from '../../fingerprint-key-import'
import { openTestStore } from '../../test-support/open-test-store'

const SERVER_KEY = Buffer.from('a'.repeat(64), 'hex')
const OTHER_KEY = Buffer.from('b'.repeat(64), 'hex')
const MATERIAL = 'sk-ant-api03-not-a-real-key'

describe('the fingerprint is a truncated KEYED mac', () => {
  it('is stable for the same key, material and server key', () => {
    expect(secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)).toBe(
      secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY),
    )
  })

  it('is 16 hex characters — the declared truncation, not the whole mac', () => {
    const fp = secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)
    expect(fp).toMatch(/^[0-9a-f]+$/)
    expect(fp.length).toBe(FINGERPRINT_BYTES * 2)
    expect(fp.length).toBe(16)
  })

  it('CHANGES when the server key changes — this is what a digest cannot do', () => {
    expect(secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)).not.toBe(
      secretFingerprint('apiKeys.anthropic', MATERIAL, OTHER_KEY),
    )
  })

  it('is NOT the bare digest of the material, in any of the obvious spellings', () => {
    const fp = secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)
    const digests = [
      createHash('sha256').update(MATERIAL).digest('hex'),
      createHash('sha256').update(`apiKeys.anthropic ${MATERIAL}`).digest('hex'),
      createHash('sha512').update(MATERIAL).digest('hex'),
      createHash('md5').update(MATERIAL).digest('hex'),
    ]
    for (const digest of digests) {
      expect(fp).not.toBe(digest)
      expect(fp).not.toBe(digest.slice(0, 16))
    }
  })

  it('CHANGES on rotation — the one question it exists to answer', () => {
    expect(secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)).not.toBe(
      secretFingerprint('apiKeys.anthropic', `${MATERIAL}-rotated`, SERVER_KEY),
    )
  })

  it('is DOMAIN SEPARATED — the same material in two slots fingerprints differently', () => {
    expect(secretFingerprint('apiKeys.openai', MATERIAL, SERVER_KEY)).not.toBe(
      secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY),
    )
  })

  it('discloses nothing of the material by inspection', () => {
    const fp = secretFingerprint('apiKeys.anthropic', MATERIAL, SERVER_KEY)
    expect(fp).not.toContain('sk-')
    expect(MATERIAL).not.toContain(fp)
  })

  it('REFUSES empty material — an absent secret has no fingerprint', () => {
    expect(() => secretFingerprint('apiKeys.openai', '', SERVER_KEY)).toThrow(/no fingerprint/)
  })
})

describe('the presence projection carries presence, a mac and a time — and no material', () => {
  it('a configured secret is present with a fingerprint', () => {
    const wire = secretPresence('apiKeys.openai', MATERIAL, SERVER_KEY, '2026-07-30T00:00:00.000Z')
    expect(wire).toEqual({
      key: 'apiKeys.openai',
      present: true,
      fingerprint: secretFingerprint('apiKeys.openai', MATERIAL, SERVER_KEY),
      updatedAt: '2026-07-30T00:00:00.000Z',
    })
  })

  it('has exactly the three members plus the join key — no value key to strip', () => {
    const wire = secretPresence('apiKeys.openai', MATERIAL, SERVER_KEY)
    expect(Object.keys(wire).sort()).toEqual(['fingerprint', 'key', 'present', 'updatedAt'])
    // The material is consumed and never returned, at any nesting.
    expect(JSON.stringify(wire)).not.toContain(MATERIAL)
  })

  it("today's `''` spelling of absence is present:false with BOTH nullables null", () => {
    expect(secretPresence('apiKeys.openai', '', SERVER_KEY, '2026-07-30T00:00:00.000Z')).toEqual({
      key: 'apiKeys.openai',
      present: false,
      fingerprint: null,
      updatedAt: null,
    })
  })
})

describe('database fingerprint key migration', () => {
  const roots: string[] = []
  const databases: SqlDatabase[] = []
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'podium-fp-'))
    roots.push(root)
    const db = openDatabase(':memory:')
    databases.push(db)
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE server_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
    return { root, db, path: join(root, FINGERPRINT_KEY_FILE) }
  }
  function key(db: SqlDatabase): Buffer {
    const row = db.prepare('SELECT value FROM server_secrets WHERE key = ?').get(FINGERPRINT_SECRET_KEY) as { value: string }
    return Buffer.from(row.value, 'hex')
  }
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it.each(['a'.repeat(64), ' ABCDEF0123\n', 'abcdzz', ''])('preserves the legacy decoded key and fingerprint (%s)', (raw) => {
    const { root, db, path } = fixture()
    writeFileSync(path, raw)
    const before = secretFingerprint('apiKeys.openai', MATERIAL, Buffer.from(raw.trim(), 'hex'))
    importFingerprintKey(db, root)
    expect(secretFingerprint('apiKeys.openai', MATERIAL, key(db))).toBe(before)
    expect(existsSync(path)).toBe(false)
    importFingerprintKey(db, root)
    expect(secretFingerprint('apiKeys.openai', MATERIAL, key(db))).toBe(before)
  })

  it('retains the file and rolls back the marker if the database write fails', () => {
    const { root, db, path } = fixture()
    writeFileSync(path, SERVER_KEY.toString('hex'))
    db.exec("CREATE TRIGGER refuse_key BEFORE INSERT ON server_secrets BEGIN SELECT RAISE(ABORT, 'key failed'); END")
    expect(() => importFingerprintKey(db, root)).toThrow('key failed')
    expect(existsSync(path)).toBe(true)
    expect(db.prepare('SELECT * FROM meta').all()).toEqual([])
    db.exec('DROP TRIGGER refuse_key')
    importFingerprintKey(db, root)
    expect(key(db)).toEqual(SERVER_KEY)
    expect(existsSync(path)).toBe(false)
  })

  it('resumes committed cleanup without importing a replacement file', () => {
    const { root, db, path } = fixture()
    db.prepare('INSERT INTO server_secrets VALUES (?, ?, ?)').run(FINGERPRINT_SECRET_KEY, SERVER_KEY.toString('hex'), 'now')
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(FINGERPRINT_IMPORT_MARKER, 'pending-cleanup')
    writeFileSync(path, OTHER_KEY.toString('hex'))
    importFingerprintKey(db, root)
    expect(key(db)).toEqual(SERVER_KEY)
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, OTHER_KEY.toString('hex'))
    importFingerprintKey(db, root)
    expect(key(db)).toEqual(SERVER_KEY)
  })

  it('creates distinct persistent database keys without creating files', () => {
    const a = fixture()
    const b = fixture()
    importFingerprintKey(a.db, a.root)
    importFingerprintKey(b.db, b.root)
    const first = key(a.db)
    expect(first.length).toBe(32)
    expect(first).not.toEqual(key(b.db))
    importFingerprintKey(a.db, a.root)
    expect(key(a.db)).toEqual(first)
    expect(existsSync(a.path)).toBe(false)
  })

  it('imports through store migration and reads the same key after reopening', async () => {
    const { root, path } = fixture()
    writeFileSync(path, SERVER_KEY.toString('hex'))
    const dbPath = join(root, 'podium.db')
    const before = secretFingerprint('apiKeys.openai', MATERIAL, SERVER_KEY)
    for (let n = 0; n < 2; n++) {
      const store = await openTestStore(dbPath)
      try {
        expect(secretFingerprint('apiKeys.openai', MATERIAL, await store.secrets.fingerprintKey())).toBe(before)
        expect(existsSync(path)).toBe(false)
      } finally {
        await store.close()
      }
    }
  })
})
