import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  INSTALLATION_FILE,
  INSTALLATION_META_KEY,
  INSTALLATION_PRIVATE_KEY,
  mintInstallationIdentity,
  parseInstallationIdentity,
} from '@podium/runtime/installation-identity'
import type { SqlDatabase } from '@podium/runtime/sqlite'

export const INSTALLATION_IMPORT_MARKER = 'installation_identity_import_v1'

/** One-time data migration, on the exclusive migration connection. The key,
 * metadata and cleanup receipt commit together before retiring the legacy file.
 * A crash between commit and unlink resumes cleanup, never imports or mints again.
 * In-memory databases have no legacy directory to import. */
export function importInstallationIdentity(db: SqlDatabase, directory?: string): void {
  const marker = () =>
    (
      db.prepare('SELECT value FROM meta WHERE key = ?').get(INSTALLATION_IMPORT_MARKER) as
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
          raw = readFileSync(join(directory, INSTALLATION_FILE), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      const identity =
        raw === undefined
          ? mintInstallationIdentity()
          : parseInstallationIdentity(join(directory!, INSTALLATION_FILE), raw)
      const { privateKey, ...metadata } = identity
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        INSTALLATION_META_KEY,
        JSON.stringify(metadata),
      )
      db.prepare('INSERT INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?)').run(
        INSTALLATION_PRIVATE_KEY,
        privateKey,
        identity.createdAt,
      )
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        INSTALLATION_IMPORT_MARKER,
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
      throw new Error('installation import cleanup requires its state directory')
    try {
      unlinkSync(join(directory, INSTALLATION_FILE))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      'complete',
      INSTALLATION_IMPORT_MARKER,
    )
  }
}
