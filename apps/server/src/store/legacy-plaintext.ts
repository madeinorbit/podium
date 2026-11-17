// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/**
 * THE OLD PLAINTEXT IS DESTROYED ONCE MOVED (credential management design §7;
 * plan Task 21).
 *
 * Before the vault, provider keys sat in plain text in `accounts.credential` and
 * in the `apiKeys.*` server secrets; the Linear key and the Telegram token sat in
 * plain text in `server_secrets` until they were sealed in place; a native login
 * transfer could leave a login file there. The boot moves each key into the
 * vault (`importLegacyCredentials`); this step then:
 *
 *  1. deletes each old value whose credential was checked to open to the same
 *     value (`legacyValuesToDestroy` decides; nothing here reads a secret),
 *     with `secure_delete` on, in one transaction that also records that the
 *     file needs compacting;
 *  2. compacts the file (`VACUUM`), because SQLite keeps deleted and overwritten
 *     values in free pages and unused cell space, then truncates the WAL, whose
 *     frames hold page images from before. A truncate kept busy by a reader is
 *     retried; when it stays busy the state row says so and the next start
 *     finishes it;
 *  3. scrubs Podium's retained upgrade snapshots (`legacy-snapshot-scrub.ts`).
 *
 * The state row (`meta['legacy-plaintext']`) makes a start after a clean pass do
 * nothing: `done` with no old row left skips the step.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

/** The `meta` key of the step's state. */
export const LEGACY_PLAINTEXT_STATE_KEY = 'legacy-plaintext'
/** The `meta` key of the snapshot identities already scrubbed (JSON). */
export const LEGACY_PLAINTEXT_SNAPSHOTS_KEY = 'legacy-plaintext:snapshots'

/**
 * - absent: the step never ran (a database from before this release).
 * - `compaction-pending`: values were deleted and the file is not yet compacted.
 * - `compacted`: the file is compact; an old value was left or a snapshot is not clean.
 * - `done`: nothing left.
 */
export type LegacyPlaintextState = 'compaction-pending' | 'compacted' | 'done'

/** Test seams for the step, passed through `SessionStore.open`. */
export interface LegacyPlaintextOptions {
  /** false: move the keys but destroy nothing (a test arranging the state in between). */
  destroy?: boolean
  /** Truncate attempts before the step leaves compaction pending. Default 20. */
  attempts?: number
  /** Waits between attempts. Default: a synchronous sleep. */
  wait?: (ms: number) => void
}

/** What the step did at this start; `{ ran: false }` when it had nothing to do. */
export type LegacyPlaintextReport =
  | { ran: false }
  | {
      ran: true
      destroyed: number
      /** Old values left in place, by id (never the value). */
      leftInPlace: string[]
      compaction: 'clean' | 'busy' | 'skipped'
      /** Snapshots that could not be scrubbed, by path and reason. */
      snapshotProblems: string[]
    }

/** One old value to delete, checked against its credential by the caller. */
export interface LegacyValueToDestroy {
  kind: 'account-row' | 'api-key-secret'
  /** `accounts.id`, or the `server_secrets` key. */
  legacyId: string
  /** The value that was checked; the row goes only if it still holds it. */
  value: string
}

export function readLegacyPlaintextState(db: SqlDatabase): LegacyPlaintextState | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_PLAINTEXT_STATE_KEY) as
    | { value: string }
    | undefined
  return row?.value as LegacyPlaintextState | undefined
}

export function writeLegacyPlaintextState(db: SqlDatabase, state: LegacyPlaintextState): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(LEGACY_PLAINTEXT_STATE_KEY, state)
}

/** True while an old row is left: an `accounts` row or an `apiKeys.*` secret. */
export function hasLegacyPlaintextRows(db: SqlDatabase): boolean {
  const accounts = db.prepare('SELECT 1 FROM accounts LIMIT 1').get()
  const apiKeys = db
    .prepare("SELECT 1 FROM server_secrets WHERE substr(key, 1, 8) = 'apiKeys.' LIMIT 1")
    .get()
  return accounts !== undefined || apiKeys !== undefined
}

function withSecureDelete<T>(db: SqlDatabase, run: () => T): T {
  const previous = (db.prepare('PRAGMA secure_delete').get() as { secure_delete: number })
    .secure_delete
  db.exec('PRAGMA secure_delete = ON')
  try {
    return run()
  } finally {
    db.exec(`PRAGMA secure_delete = ${previous === 2 ? 'FAST' : previous === 1 ? 'ON' : 'OFF'}`)
  }
}

/**
 * Delete the checked old values and the `accounts` rows that hold none, in one
 * transaction with `secure_delete` on, and record that the file needs
 * compacting. Before an `accounts` row goes, its creation time is copied onto
 * the credential made from it, so the old shared-key order (oldest row first,
 * `legacySharedCandidates`) survives the row. Returns how many values it deleted.
 */
export function applyLegacyDestruction(
  db: SqlDatabase,
  values: readonly LegacyValueToDestroy[],
): number {
  return withSecureDelete(db, () => {
    let deleted = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      // Every row's creation time onto its credential first, kept rows too.
      const keepOrder = db.prepare(
        'UPDATE credentials SET created_at = ? WHERE legacy_id = ? AND created_at <> ?',
      )
      for (const row of db.prepare('SELECT id, created_at AS at FROM accounts').all() as {
        id: string
        at: number
      }[]) {
        const iso = new Date(row.at).toISOString()
        keepOrder.run(iso, row.id, iso)
      }
      const sends = db.prepare('DELETE FROM account_machine_sends WHERE account_id = ?')
      const account = db.prepare('DELETE FROM accounts WHERE id = ? AND credential = ?')
      const secret = db.prepare('DELETE FROM server_secrets WHERE key = ? AND value = ?')
      for (const value of values) {
        if (value.kind === 'account-row') {
          const gone = Number(account.run(value.legacyId, value.value).changes)
          if (gone > 0) sends.run(value.legacyId)
          deleted += gone
        } else {
          deleted += Number(secret.run(value.legacyId, value.value).changes)
        }
      }
      // Rows that never held a value have nothing to check.
      const empty = db.prepare("SELECT id FROM accounts WHERE credential = ''").all() as {
        id: string
      }[]
      for (const { id } of empty) {
        sends.run(id)
        db.prepare("DELETE FROM accounts WHERE id = ? AND credential = ''").run(id)
      }
      // A first pass compacts even with nothing to delete: sealing the Linear key
      // and the Telegram token in place, and the transfer sweep, left old bytes.
      const state = readLegacyPlaintextState(db)
      if (deleted > 0 || state === undefined || state === 'compaction-pending') {
        writeLegacyPlaintextState(db, 'compaction-pending')
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return deleted
  })
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Compact the file and truncate its WAL, so no deleted or overwritten value is
 * left in a free page, unused cell space or an old WAL frame. The truncate is
 * retried while a reader keeps it busy (50 ms, doubling, at most 1 s apart).
 * `clean` moves the state on to `compacted`; `busy` leaves it pending.
 * Must run on a connection with no open transaction.
 */
export function compactDatabase(
  db: SqlDatabase,
  options: Pick<LegacyPlaintextOptions, 'attempts' | 'wait'> = {},
): 'clean' | 'busy' {
  const attempts = options.attempts ?? 20
  const wait = options.wait ?? sleep
  return withSecureDelete(db, () => {
    db.exec('VACUUM')
    // Each try answers at once; the waits between tries are ours, not the
    // connection's busy timeout (seconds per try).
    const timeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout
    db.exec('PRAGMA busy_timeout = 0')
    try {
      if (!truncateWal(db, attempts, wait)) return 'busy'
    } finally {
      db.exec(`PRAGMA busy_timeout = ${Number(timeout) || 0}`)
    }
    writeLegacyPlaintextState(db, 'compacted')
    // The state write is a WAL frame with no secret in it; fold it in too.
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    return 'clean'
  })
}

/** `PRAGMA wal_checkpoint(TRUNCATE)` until no reader keeps it busy, or `attempts` run out. */
function truncateWal(db: SqlDatabase, attempts: number, wait: (ms: number) => void): boolean {
  let delay = 50
  for (let attempt = 1; ; attempt += 1) {
    const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy: number }
      | undefined
    if (!result || result.busy === 0) return true
    if (attempt >= attempts) return false
    wait(delay)
    delay = Math.min(delay * 2, 1_000)
  }
}
