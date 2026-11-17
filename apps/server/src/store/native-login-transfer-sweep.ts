import { createLogger } from '@podium/logger'
import type { SqlDatabase } from '@podium/runtime/sqlite'

const log = createLogger('server:secrets')

/** The key prefix of the plaintext transfer rows versions before POD-7044 wrote. */
export const OLD_NATIVE_LOGIN_TRANSFER_PREFIX = 'native-login-transfer:'

// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/**
 * Delete the native login transfer rows an older version left in
 * `server_secrets`, and their bytes with them [POD-7044].
 *
 * Before POD-7044 a login propagation parked the donor's login file there, as
 * plain JSON, between export and install. A crash in that window left the row.
 * Nothing writes one now (the bundle stays in memory), so any row found here is
 * left over and is never read again.
 *
 * A plain DELETE frees the cells and overflow pages but leaves their bytes in
 * the file, and the WAL keeps the page images it held. So the delete runs with
 * `secure_delete` on, which zeroes freed cells and freed pages, and the WAL is
 * then checkpointed and truncated so the zeroed pages replace the old ones in
 * the database file and no old frame remains. Run on the boot connection, before
 * anything else is open on the file. Returns how many rows it deleted.
 */
export function sweepOldNativeLoginTransfers(db: SqlDatabase): number {
  const { count } = db
    .prepare('SELECT count(*) AS count FROM server_secrets WHERE substr(key, 1, ?) = ?')
    .get(OLD_NATIVE_LOGIN_TRANSFER_PREFIX.length, OLD_NATIVE_LOGIN_TRANSFER_PREFIX) as {
    count: number
  }
  if (count === 0) return 0
  const previous = (db.prepare('PRAGMA secure_delete').get() as { secure_delete: number })
    .secure_delete
  db.exec('PRAGMA secure_delete = ON')
  try {
    db.prepare('DELETE FROM server_secrets WHERE substr(key, 1, ?) = ?').run(
      OLD_NATIVE_LOGIN_TRANSFER_PREFIX.length,
      OLD_NATIVE_LOGIN_TRANSFER_PREFIX,
    )
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy: number }
      | undefined
    if (checkpoint && checkpoint.busy !== 0) {
      log.warn('old login transfer rows deleted; the WAL could not be truncated yet', { count })
    } else {
      log.info('deleted old login transfer rows and their bytes', { count })
    }
  } finally {
    db.exec(`PRAGMA secure_delete = ${previous === 2 ? 'FAST' : previous === 1 ? 'ON' : 'OFF'}`)
  }
  return count
}
