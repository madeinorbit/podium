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
 *
 * WHAT IS NOT TRIED AGAIN (POD-7252). A snapshot written after the live file's
 * last clean compaction is a copy of the clean file and is left alone. A failed
 * snapshot is tried at most {@link SNAPSHOT_SCRUB_ATTEMPTS} times while it keeps
 * its size and mtime; after that it is given up, reported once, until retention
 * prunes it. The scrub runs after the server is up (`StoreDatabase`), so none of
 * this is on the boot's path.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
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

/** A snapshot that failed, as `stat` knew it then, and how many tries it has had. */
export interface SnapshotFailure extends SnapshotStamp {
  attempts: number
}

/** Tries a snapshot gets while its size and mtime stay the same. */
export const SNAPSHOT_SCRUB_ATTEMPTS = 3

export interface SnapshotScrubResult {
  path: string
  /**
   * `clean-copy`: written after the live file's last clean compaction.
   * `given-up`: failed {@link SNAPSHOT_SCRUB_ATTEMPTS} times as it is; not tried.
   */
  outcome: 'scrubbed' | 'already-scrubbed' | 'clean-copy' | 'failed' | 'given-up'
  /** Why it failed (never a value). */
  reason?: string
  /** The scrubbed file's stamp, to remember. */
  stamp?: SnapshotStamp
  /** A failed or given-up snapshot's record, to remember. */
  failure?: SnapshotFailure
}

export interface SnapshotScrubOptions {
  /** Values to search the scrubbed copy for, besides those read out of the snapshot. */
  knownValues?: readonly string[]
  /** Stamps of snapshots already scrubbed. */
  done?: readonly SnapshotStamp[]
  /** Snapshots that failed before, with their tries. */
  failures?: readonly SnapshotFailure[]
  /**
   * When the live file was last compacted clean (epoch ms). A snapshot modified
   * after it is a copy of the clean file.
   */
  cleanSinceMs?: number
  /** Test seam: runs just before the rename (a throw stands for a crash). */
  beforeReplace?: (snapshotPath: string) => void
  /** Free bytes on the snapshot's filesystem. Default: `freeDiskBytes`. */
  freeBytes?: (dir: string) => number
}

const SEALED_PLAIN_KEYS = ['integrations.linearApiKey', 'notifications.telegramBotToken']

/** The keyed secret tables: `server_secrets`, and `workspace_secrets` since the workspace split. */
const SECRET_TABLES = ['server_secrets', 'workspace_secrets'] as const

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
  // A snapshot from after the workspace split (POD-7013) holds them in workspace_secrets.
  for (const table of SECRET_TABLES) {
    if (!have.has(table)) continue
    for (const r of db.prepare(`SELECT value FROM ${table} WHERE ${SECRET_ROW_FILTER}`).all() as {
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
    for (const table of SECRET_TABLES)
      if (have.has(table)) db.exec(`DELETE FROM ${table} WHERE ${SECRET_ROW_FILTER}`)
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

/** Whether the file at `path` holds any of `needles`, read in pieces, never whole. */
function fileHoldsAny(path: string, needles: readonly Buffer[]): boolean {
  if (needles.length === 0) return false
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1
  const chunk = Buffer.alloc(4 * 1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    let tail = Buffer.alloc(0)
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) return false
      const window = Buffer.concat([tail, chunk.subarray(0, read)])
      if (needles.some((needle) => window.includes(needle))) return true
      tail = Buffer.from(window.subarray(Math.max(0, window.length - overlap)))
    }
  } finally {
    closeSync(fd)
  }
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
    const needles = values.flatMap(needlesOf).map((needle) => Buffer.from(needle, 'utf8'))
    if (fileHoldsAny(temp, needles)) {
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
 * What a scrub would do with each retained snapshot, from `stat` alone: the
 * result for one it leaves alone, or `undefined` for one it would scrub.
 */
function settledWithoutScrub(
  path: string,
  options: SnapshotScrubOptions,
): SnapshotScrubResult | undefined {
  let stamp: SnapshotStamp
  try {
    stamp = stampOf(path)
  } catch {
    return { path, outcome: 'failed', reason: 'cannot be read' }
  }
  if ((options.done ?? []).some((done) => sameStamp(done, stamp))) {
    return { path, outcome: 'already-scrubbed', stamp }
  }
  if (options.cleanSinceMs !== undefined && stamp.mtimeMs > options.cleanSinceMs) {
    return { path, outcome: 'clean-copy', stamp }
  }
  const failure = (options.failures ?? []).find((failed) => sameStamp(failed, stamp))
  if (failure && failure.attempts >= SNAPSHOT_SCRUB_ATTEMPTS) {
    return { path, outcome: 'given-up', reason: 'failed every try', failure }
  }
  return undefined
}

/**
 * The retained snapshots as a scrub would find them now, from `stat` alone
 * (nothing is opened): those it would work on and the largest one's size, and
 * those that would still hold old keys after it (given up, or unreadable).
 */
export function planSnapshotScrub(
  dbPath: string,
  options: SnapshotScrubOptions = {},
): { toScrub: string[]; unclean: string[]; largestBytes: number } {
  const toScrub: string[] = []
  const unclean: string[] = []
  let largestBytes = 0
  for (const path of retainedSnapshotPaths(dbPath)) {
    const settled = settledWithoutScrub(path, options)
    if (!settled) {
      toScrub.push(path)
      largestBytes = Math.max(largestBytes, statSync(path, { throwIfNoEntry: false })?.size ?? 0)
    } else if (settled.outcome === 'given-up' || settled.outcome === 'failed') unclean.push(path)
  }
  return { toScrub, unclean, largestBytes }
}

/**
 * Scrub every retained snapshot of `dbPath` that needs it, newest first. Returns
 * one result per snapshot; a failure carries its count of tries.
 */
export function scrubLegacySnapshots(
  dbPath: string,
  options: SnapshotScrubOptions = {},
): SnapshotScrubResult[] {
  removeStaleTemps(dbPath)
  return retainedSnapshotPaths(dbPath).map((path) => {
    const settled = settledWithoutScrub(path, options)
    if (settled) return settled
    const before = stampOf(path)
    const result = scrubOne(path, options)
    if (result.outcome !== 'failed') return result
    const previous = (options.failures ?? []).find((failed) => sameStamp(failed, before))
    return { ...result, failure: { ...before, attempts: (previous?.attempts ?? 0) + 1 } }
  })
}
