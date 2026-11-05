/** The native config writers use this same file and BEGIN IMMEDIATE protocol.
 * SQLite owns exclusion and crash release; the database stores no config data.
 * Every callback is synchronous and holds ownership through durable publication. */
import { mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
// The coordination connection must stay below config/profile/query attribution:
// the attributed facade resolves profile settings through config at module load.
import { openBunDatabase } from './sqlite/bun'

// Synchronous config notifications may call another config owner in this process.
// The outer database transaction continues to exclude every other process.
const held = new Set<string>()

export function withConfigWriteLock<T>(path: string, write: () => T): T {
  mkdirSync(dirname(path), { recursive: true })
  const canonical = join(realpathSync(dirname(path)), basename(path))
  if (held.has(canonical)) return write()
  const db = openBunDatabase(`${canonical}.write-lock.sqlite`)
  let acquired = false
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    acquired = true
    held.add(canonical)
    return write()
  } finally {
    held.delete(canonical)
    try {
      if (acquired) db.exec('ROLLBACK')
    } finally {
      db.close()
    }
  }
}
