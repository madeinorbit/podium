import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './config'
import { openDatabase, type SqlDatabase } from './sqlite'
import {
  acceptsUpdateKeyRotation,
  updateKeyRotationPayload,
  verifyUpdateKeyRotation,
  type UpdateKeyRotation,
} from './update-key-trust'

/** The one update-signing identity owned by this server instance. */
export interface UpdateSigningKey {
  /** PKCS#8 DER, base64 encoded. Server-only. */
  privateKey: string
  /** SPKI DER, base64 encoded. Safe to send to a pairing daemon. */
  publicKey: string
  /** Old-key-signed path by which an already-pinned daemon may reach this key. */
  rotations: UpdateKeyRotation[]
}

const FILE_NAME = 'update-signing-key.json'
const PUBLIC_ANCHOR_FILE_NAME = 'update-signing-key.pub'

function invalidKey(path: string): Error {
  return new Error(`invalid persisted update signing key at ${path}`)
}

function parsePersistedKey(path: string, raw: string): UpdateSigningKey {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) throw invalidKey(path)
    const candidate = value as {
      privateKey?: unknown
      publicKey?: unknown
      rotations?: unknown
    }
    if (typeof candidate.privateKey !== 'string' || candidate.privateKey.length === 0)
      throw invalidKey(path)
    if (typeof candidate.publicKey !== 'string' || candidate.publicKey.length === 0)
      throw invalidKey(path)

    // Do not silently accept a file whose public half no longer matches the private
    // half. Re-minting here would rotate the trust root on a damaged state directory.
    const privateKey = createPrivateKey({
      key: Buffer.from(candidate.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    const derivedPublicKey = createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64')
    if (derivedPublicKey !== candidate.publicKey) throw invalidKey(path)

    const rotations = candidate.rotations ?? []
    if (!Array.isArray(rotations)) throw invalidKey(path)
    let previous: string | undefined
    const parsedRotations: UpdateKeyRotation[] = []
    for (const value of rotations) {
      if (typeof value !== 'object' || value === null) throw invalidKey(path)
      const rotation = value as Partial<UpdateKeyRotation>
      if (
        typeof rotation.from !== 'string' ||
        typeof rotation.to !== 'string' ||
        typeof rotation.signature !== 'string'
      )
        throw invalidKey(path)
      if (previous !== undefined && rotation.from !== previous) throw invalidKey(path)
      if (!verifyUpdateKeyRotation(rotation as UpdateKeyRotation)) throw invalidKey(path)
      parsedRotations.push(rotation as UpdateKeyRotation)
      previous = rotation.to
    }
    if (previous !== undefined && previous !== candidate.publicKey) throw invalidKey(path)
    return {
      privateKey: candidate.privateKey,
      publicKey: candidate.publicKey,
      rotations: parsedRotations,
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `invalid persisted update signing key at ${path}`
    )
      throw error
    throw invalidKey(path)
  }
}

export function mintUpdateSigningKey(): UpdateSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    rotations: [],
  }
}

const KEY = 'updates.signingKey'
const ANCHOR = 'updates.signingKeyAnchor'
const IMPORT_MARKER = 'update_signing_key_imported_v1'

function readSecret(db: SqlDatabase, name: string): string | undefined {
  return (db.prepare('SELECT value FROM server_secrets WHERE key = ?').get(name) as
    { value: string } | undefined)?.value
}

function writeSecret(db: SqlDatabase, name: string, value: string): void {
  db.prepare('INSERT INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(name, value, new Date().toISOString())
}

function assertAnchor(anchor: string | undefined, key: UpdateSigningKey): void {
  if (anchor !== undefined && anchor !== key.publicKey &&
      !acceptsUpdateKeyRotation(anchor, key.publicKey, key.rotations)) {
    throw new Error('persisted update signing key does not match its public anchor')
  }
}

/** One-time upgrade, called only from the store's exclusive migration lane.
 * The committed marker makes database authority irreversible. The intermediate
 * phase lets a crash after commit finish deleting files without re-importing them.
 */
export function importUpdateSigningKey(db: SqlDatabase, dir: string): void {
  const marker = () => (db.prepare('SELECT value FROM meta WHERE key = ?')
    .get(IMPORT_MARKER) as { value: string } | undefined)?.value
  if (marker() === 'complete') return
  const path = join(dir, FILE_NAME)
  const anchorPath = join(dir, PUBLIC_ANCHOR_FILE_NAME)
  db.exec('BEGIN IMMEDIATE')
  try {
    if (marker() === undefined) {
      const raw = existsSync(path) ? readFileSync(path, 'utf8') : undefined
      const anchor = existsSync(anchorPath) ? readFileSync(anchorPath, 'utf8').trim() : undefined
      if (anchor === '') throw new Error('invalid update signing key anchor')
      if (raw !== undefined) {
        const key = parsePersistedKey(path, raw)
        assertAnchor(anchor, key)
        const existing = readSecret(db, KEY)
        if (existing !== undefined && JSON.stringify(parsePersistedKey(KEY, existing)) !== JSON.stringify(key)) {
          throw new Error('update signing key import conflicts with database key')
        }
        assertAnchor(readSecret(db, ANCHOR), key)
        writeSecret(db, KEY, JSON.stringify(key))
        writeSecret(db, ANCHOR, anchor ?? key.publicKey)
      } else if (anchor !== undefined) {
        // Preserve evidence of a lost key; ordinary startup must not mint over a pin.
        writeSecret(db, ANCHOR, anchor)
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(IMPORT_MARKER, 'files-pending')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  rmSync(path, { force: true })
  rmSync(anchorPath, { force: true })
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('complete', IMPORT_MARKER)
}

/** A directory addresses an existing, migrated installation database, never a key file. */
function withDatabase<T>(source: SqlDatabase | string, fn: (db: SqlDatabase) => T): T {
  if (typeof source !== 'string') return fn(source)
  const path = join(source, 'podium.db')
  if (!existsSync(path)) throw new Error('update signing key requires an initialized installation database')
  const db = openDatabase(path)
  try { return fn(db) } finally { db.close() }
}

function readOrCreate(db: SqlDatabase, opts: { allowCreate?: boolean; confirmNoPins?: boolean }): UpdateSigningKey {
  const raw = readSecret(db, KEY)
  const anchor = readSecret(db, ANCHOR)
  if (raw !== undefined) {
    const key = parsePersistedKey(KEY, raw)
    if (!opts.confirmNoPins) {
      if (anchor === undefined) throw new Error('persisted update signing key is missing its public anchor')
      assertAnchor(anchor, key)
    } else {
      writeSecret(db, ANCHOR, key.publicKey)
    }
    return key
  }
  if (opts.allowCreate === false || (anchor !== undefined && !opts.confirmNoPins)) {
    throw new Error('refusing to mint a replacement update signing key: enrolled machines may still trust the missing key. Restore the installation database; if no machine ever pinned it, run `podium update-key initialize --confirm-no-pins`.')
  }
  const key = mintUpdateSigningKey()
  writeSecret(db, KEY, JSON.stringify(key))
  writeSecret(db, ANCHOR, key.publicKey)
  return key
}

function transaction<T>(db: SqlDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Read or initialize the installation's key atomically in server_secrets. */
export function readOrCreateUpdateSigningKey(
  source: SqlDatabase | string = stateDir(),
  opts: { allowCreate?: boolean; confirmNoPins?: boolean } = {},
): UpdateSigningKey {
  return withDatabase(source, db => transaction(db, () => readOrCreate(db, opts)))
}

/** Deliberate rotation preserves the full old-key-signed path for offline pins. */
export function rotateUpdateSigningKey(source: SqlDatabase | string = stateDir()): UpdateSigningKey {
  return withDatabase(source, db => transaction(db, () => {
    const current = readOrCreate(db, { allowCreate: false })
    const next = mintUpdateSigningKey()
    const privateKey = createPrivateKey({
      key: Buffer.from(current.privateKey, 'base64'), format: 'der', type: 'pkcs8',
    })
    const rotation: UpdateKeyRotation = {
      from: current.publicKey,
      to: next.publicKey,
      signature: sign(null, updateKeyRotationPayload(current.publicKey, next.publicKey), privateKey).toString('base64'),
    }
    const rotated = { ...next, rotations: [...current.rotations, rotation] }
    writeSecret(db, KEY, JSON.stringify(rotated))
    return rotated
  }))
}
