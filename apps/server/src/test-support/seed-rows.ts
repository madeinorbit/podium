/**
 * SEEDING SYNCED TABLES BELOW THE COMMIT LAYER (POD-6920).
 *
 * Once a change log is attached to a store (a registry, a test Ledger over
 * the store's records), every write of a row a synced record reads is
 * captured, and a transaction that leaves its capture undrained is refused:
 * no write can bypass the log. A test fixture that writes such rows
 * directly, to set up state rather than to exercise a write path, says so
 * here: the write runs in one transaction whose capture is taken and
 * dropped, so it reaches the tables and not the log.
 */

import type { SessionStore } from '../store'
import { spanOpen } from '../store/executor/executor'

export async function seedRows<T>(
  store: Pick<SessionStore, 'transact' | 'sync'>,
  write: () => Promise<T>,
): Promise<T> {
  // Only what this write captured: a seed inside an open commit leaves the
  // commit's own changes to it.
  const mark = spanOpen() ? await store.sync.captureMark() : 0
  return await store.transact(async () => {
    const result = await write()
    await store.sync.drainCapture(mark)
    return result
  })
}

/**
 * {@link seedRows} for a fixture that writes through the raw connection (a
 * corrupt row, a hand-written value): one transaction whose capture is
 * dropped before it commits.
 */
export function seedRaw(db: { exec(sql: string): void }, write: () => void): void {
  db.exec('BEGIN')
  try {
    write()
    db.exec('DELETE FROM sync_capture')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
