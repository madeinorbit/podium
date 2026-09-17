import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SqlDatabase } from '@podium/runtime/sqlite'

export const FINGERPRINT_KEY_FILE = 'secret-fingerprint.key'
export const FINGERPRINT_SECRET_KEY = 'settings.fingerprintKey'
export const FINGERPRINT_IMPORT_MARKER = 'secret_fingerprint_import_v1'

/** One-time data migration, on the exclusive migration connection. The key,
 * cleanup receipt commit together before retiring the legacy file.
 * A crash between commit and unlink resumes cleanup, never imports or mints again.
 * In-memory databases have no legacy directory to import. */
export function importFingerprintKey(db: SqlDatabase, directory?: string): void {
  const marker = () =>
    (
      db.prepare('SELECT value FROM meta WHERE key = ?').get(FINGERPRINT_IMPORT_MARKER) as
        | { value: string }
        | undefined
    )?.value
  if (marker() === 'complete') return
  db.exec('BEGIN IMMEDIATE')
  try {
    if (marker() === undefined) {
      let raw: string | undefined
      if (directory !== undefined) {
        try {
          raw = readFileSync(join(directory, FINGERPRINT_KEY_FILE), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      // Preserve precisely the bytes the legacy reader used, including its hex
      // decoding semantics. Never replace an existing file with a fresh key.
      const key = raw === undefined ? randomBytes(32) : Buffer.from(raw.trim(), 'hex')
      db.prepare('INSERT INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?)').run(
        FINGERPRINT_SECRET_KEY,
        key.toString('hex'),
        new Date().toISOString(),
      )
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        FINGERPRINT_IMPORT_MARKER,
        raw === undefined ? 'complete' : 'pending-cleanup',
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  if (marker() === 'pending-cleanup') {
    if (directory === undefined)
      throw new Error('fingerprint import cleanup requires its state directory')
    try {
      unlinkSync(join(directory, FINGERPRINT_KEY_FILE))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      'complete',
      FINGERPRINT_IMPORT_MARKER,
    )
  }
}
