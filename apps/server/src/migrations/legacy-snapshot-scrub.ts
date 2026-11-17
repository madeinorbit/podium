// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/**
 * THE OLD KEYS LEAVE PODIUM'S OWN UPGRADE SNAPSHOTS TOO (credential management
 * design §7, "Podium's own upgrade snapshots are cleaned too"; plan Task 21).
 *
 * Before a schema change the server copies the database into the state
 * directory (`podium.db.backup-v*`, `backup.ts`) and keeps the newest three.
 * Those copies hold the keys stored before the vault. For each one:
 *
 *  1. a `-wal` with frames is folded into it first (SQLite's own crash-safe
 *     checkpoint; the content does not change);
 *  2. `VACUUM INTO` a temporary sibling whose name retention and discovery
 *     never match (`.podium.db.scrub-<uuid>`);
 *  3. in the copy, with `secure_delete` on: the `accounts` rows that hold a key,
 *     their sends, the `apiKeys.*` secrets, the Linear key and Telegram token
 *     where still plain, old native login transfers, and the same five secrets
 *     in an old `meta['settings']` blob are removed; then `VACUUM`;
 *  4. the copy must pass `PRAGMA integrity_check`, keep the snapshot's schema
 *     and `user_version`, and hold none of the values read out of the snapshot
 *     (nor the ones the caller knows);
 *  5. it is fsynced, given the snapshot's mtime (retention orders by it) and
 *     renamed over the snapshot. Rename is atomic: a crash leaves the old file
 *     or the new one. The stale `-shm` goes; the `-wal` is empty by then.
 *
 * Any failure removes the copy and leaves the snapshot as it was, reported.
 * `.partial-` files are never listed (`retainedSnapshotPaths`) and never touched.
 * The verifier's catalogue keys on size and mtime, so a replaced snapshot
 * stops matching its old record and is verified again.
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fsyncPath } from '@podium/runtime/fsync'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { freeDiskBytes, retainedSnapshotPaths } from './backup'

/** A snapshot as `stat` knows it; a scrubbed one is not scrubbed again. */
export interface SnapshotStamp {
  path: string
  size: number
  mtimeMs: number
}

export interface SnapshotScrubResult {
  path: string
  outcome: 'scrubbed' | 'already-scrubbed' | 'failed'
  /** Why it failed (never a value). */
  reason?: string
  /** The scrubbed file's stamp, to remember. */
  stamp?: SnapshotStamp
}

export interface SnapshotScrubOptions {
  /** Values to search the scrubbed copy for, besides those read out of the snapshot. */
  knownValues?: readonly string[]
  /** Stamps of snapshots already scrubbed. */
  done?: readonly SnapshotStamp[]
  /** Test seam: runs just before the rename (a throw stands for a crash). */
  beforeReplace?: (snapshotPath: string) => void
  /** Free bytes on the snapshot's filesystem. Default: `freeDiskBytes`. */
  freeBytes?: (dir: string) => number
}

const SEALED_PLAIN_KEYS = ['integrations.linearApiKey', 'notifications.telegramBotToken']

/** Where an old `meta['settings']` blob kept secrets, before `server_secrets`. */
const BLOB_SECRET_PATHS = [
  '$.apiKeys.anthropic',
  '$.apiKeys.openai',
  '$.apiKeys.openrouter',
  '$.integrations.linearApiKey',
  '$.notifications.telegramBotToken',
]

const SECRET_ROW_FILTER = `substr(key, 1, 8) = 'apiKeys.'
  OR substr(key, 1, 22) = 'native-login-transfer:'
  OR (key IN (${SEALED_PLAIN_KEYS.map((k) => `'${k}'`).join(', ')}) AND substr(value, 1, 9) <> 'vault:v1:')`

/** The prefix of a scrub's temporary file; never a `<db>.backup-v` name. */
const tempPrefix = (dbFile: string): string => `.${dbFile}.scrub-`

const tables = (db: SqlDatabase): Set<string> =>
  new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name),
  )

/** The schema a scrub must keep: every object's definition, and `user_version`. */
function schemaOf(db: SqlDatabase): string {
  const objects = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all()
  const version = db.prepare('PRAGMA user_version').get()
  return JSON.stringify({ objects, version })
}

/** The old values a snapshot holds, read before they are removed. */
function valuesIn(db: SqlDatabase, have: Set<string>): string[] {
  const values: string[] = []
  if (have.has('accounts')) {
    for (const r of db.prepare("SELECT credential FROM accounts WHERE credential <> ''").all() as {
      credential: string
    }[])
      values.push(r.credential)
  }
  if (have.has('server_secrets')) {
    for (const r of db
      .prepare(`SELECT value FROM server_secrets WHERE ${SECRET_ROW_FILTER}`)
      .all() as {
      value: string
    }[])
      values.push(r.value)
  }
  if (have.has('meta')) {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'settings' AND json_valid(value)")
      .get() as { value: string } | undefined
    if (row) {
      for (const path of BLOB_SECRET_PATHS) {
        const found = db
          .prepare('SELECT json_extract(?, ?) AS v WHERE json_type(?, ?) = ?')
          .get(row.value, path, row.value, path, 'text') as { v: string } | undefined
        if (found?.v) values.push(found.v)
      }
    }
  }
  return values
}

/** Remove the old values from a scrub copy, then compact it. */
function removeValues(db: SqlDatabase, have: Set<string>): void {
  db.exec('PRAGMA secure_delete = ON')
  db.exec('BEGIN IMMEDIATE')
  try {
    if (have.has('accounts')) {
      if (have.has('account_machine_sends')) {
        db.exec(
          "DELETE FROM account_machine_sends WHERE account_id IN (SELECT id FROM accounts WHERE credential <> '')",
        )
      }
      db.exec("DELETE FROM accounts WHERE credential <> ''")
    }
    if (have.has('server_secrets')) db.exec(`DELETE FROM server_secrets WHERE ${SECRET_ROW_FILTER}`)
    if (have.has('meta')) {
      // `''` is the old blob's spelling of "not configured".
      const blank = db.prepare(
        "UPDATE meta SET value = json_set(value, ?, '') WHERE key = 'settings' AND json_valid(value) AND json_type(value, ?) = 'text'",
      )
      for (const path of BLOB_SECRET_PATHS) blank.run(path, path)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  db.exec('VACUUM')
}

/**
 * What a byte search looks for: a short value whole; a long one (a login file)
 * in 48-character pieces, since a value spread over overflow pages is never
 * contiguous in the file.
 */
function needlesOf(value: string): string[] {
  if (value.length < 8) return []
  if (value.length <= 64) return [value]
  const out: string[] = []
  for (let at = 0; at + 48 <= value.length && out.length < 16; at += 48) {
    out.push(value.slice(at, at + 48))
  }
  return out
}

function sameStamp(a: SnapshotStamp, b: SnapshotStamp): boolean {
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function stampOf(path: string): SnapshotStamp {
  const stat = statSync(path)
  return { path, size: stat.size, mtimeMs: stat.mtimeMs }
}

/** Remove what a scrub interrupted by a crash left behind. */
function removeStaleTemps(dbPath: string): void {
  const dir = dirname(dbPath)
  const prefix = tempPrefix(basename(dbPath))
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix)) rmSync(join(dir, name), { force: true })
  }
}

function scrubOne(snapshot: string, options: SnapshotScrubOptions): SnapshotScrubResult {
  const dir = dirname(snapshot)
  const before = statSync(snapshot)
  const free = (options.freeBytes ?? freeDiskBytes)(dir)
  if (free < before.size * 2) {
    return { path: snapshot, outcome: 'failed', reason: 'not enough free disk space for a copy' }
  }
  const temp = join(
    dir,
    `${tempPrefix(basename(snapshot).split('.backup-v')[0] ?? '')}${randomUUID()}`,
  )
  try {
    let schema: string
    const values: string[] = [...(options.knownValues ?? [])]
    const source = openDatabase(snapshot)
    try {
      // Fold a WAL with frames into the snapshot: the copy must hold them, and a
      // stale WAL beside the replaced file would be applied to it.
      source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      schema = schemaOf(source)
      values.push(...valuesIn(source, tables(source)))
      source.prepare('VACUUM INTO ?').run(temp)
    } finally {
      source.close()
    }
    const copy = openDatabase(temp)
    try {
      removeValues(copy, tables(copy))
      const check = copy.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
      if (check.length !== 1 || check[0]?.integrity_check !== 'ok') {
        throw new Error('the scrubbed copy failed the integrity check')
      }
      if (schemaOf(copy) !== schema) throw new Error('the scrubbed copy changed the schema')
    } finally {
      copy.close()
    }
    for (const suffix of ['-wal', '-journal']) {
      if (existsSync(`${temp}${suffix}`) && statSync(`${temp}${suffix}`).size > 0) {
        throw new Error('the scrubbed copy left a journal behind')
      }
      rmSync(`${temp}${suffix}`, { force: true })
    }
    rmSync(`${temp}-shm`, { force: true })
    const bytes = readFileSync(temp)
    if (values.flatMap(needlesOf).some((needle) => bytes.includes(Buffer.from(needle, 'utf8')))) {
      throw new Error('an old value is still in the scrubbed copy')
    }
    fsyncPath(temp)
    utimesSync(temp, before.atime, before.mtime)
    options.beforeReplace?.(snapshot)
    renameSync(temp, snapshot)
    // The snapshot's -wal is empty after the fold; its -shm describes the old file.
    rmSync(`${snapshot}-wal`, { force: true })
    rmSync(`${snapshot}-shm`, { force: true })
    fsyncPath(dir)
    return { path: snapshot, outcome: 'scrubbed', stamp: stampOf(snapshot) }
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      rmSync(`${temp}${suffix}`, { force: true })
    return {
      path: snapshot,
      outcome: 'failed',
      reason: error instanceof Error ? error.message : 'unknown error',
    }
  }
}

/**
 * Scrub every retained snapshot of `dbPath` not already scrubbed (`done`), newest
 * first. Returns one result per snapshot.
 */
export function scrubLegacySnapshots(
  dbPath: string,
  options: SnapshotScrubOptions = {},
): SnapshotScrubResult[] {
  removeStaleTemps(dbPath)
  return retainedSnapshotPaths(dbPath).map((path) => {
    const done = options.done ?? []
    try {
      if (done.some((stamp) => sameStamp(stamp, stampOf(path)))) {
        return { path, outcome: 'already-scrubbed', stamp: stampOf(path) }
      }
    } catch {
      return { path, outcome: 'failed', reason: 'cannot be read' }
    }
    return scrubOne(path, options)
  })
}
