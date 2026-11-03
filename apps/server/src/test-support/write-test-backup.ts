/**
 * A real `<db>.backup-v…` file of a real database, for tests about the snapshot
 * verifier and catalogue rather than about how backups are taken.
 *
 * Production backups come from the boot migration (`backupDatabase`), which
 * copies the file while nothing else is writing. A test store IS writing, so the
 * copy goes through a separate SQLite connection with `VACUUM INTO` instead: a
 * consistent read transaction, and no raw file descriptor whose close would drop
 * this process's POSIX SQLite locks on the live database.
 */
import { openDatabase } from '@podium/runtime/sqlite'

export function writeTestBackup(dbPath: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = `${dbPath}.backup-v${label}-${stamp}`
  const db = openDatabase(dbPath, { readOnly: true })
  try {
    db.prepare('VACUUM INTO ?').run(path)
  } finally {
    db.close()
  }
  return path
}
