/**
 * Restore a database from a backup, re-minting the feed epoch in the same step
 * (ADR 2 D1).
 *
 * ## Why this file exists at all
 *
 * ADR 2 D1 requires the authority to mint a NEW epoch whenever it cannot
 * guarantee its `seq` sequence continues the one clients hold — and restore from
 * backup is the headline case, because it is the SANCTIONED rollback path
 * ([spec:SP-4428] mandates the pre-migration backup precisely because drizzle
 * has no down migrations).
 *
 * The trap the epoch exists to catch:
 *
 *   The backup's log ends at seq 400; a client holds cursor 500. Restore, and if
 *   the client asks NOW it gets `500 > 400` → snapshot → healed. But the server
 *   keeps working, and after 100 more commits `max` is 500 again. The client asks
 *   `changesSince(500)`, hits `cursor === max`, and is told `[]` — "you are up to
 *   date". It is not: it holds entities from changes 401..500 of a timeline that
 *   no longer exists, and it also missed 401..500 of the restored one. For every
 *   entity never touched again the phantom is final, and nothing in the protocol
 *   can ever detect it.
 *
 * The epoch lives IN the database, so restoring a backup restores the old epoch
 * along with the old seqs. The bump therefore has to happen at restore time — and
 * ADR 2 D1 is emphatic that a documented runbook step is not good enough: "a
 * purely documented runbook step is exactly the thing that gets skipped at 2am
 * during the incident the rollback exists for — leaving an epoch that lies, which
 * is worse than no epoch, because it *looks* checked." D1 names a restore command
 * that copies AND re-mints in one step as the PREFERRED option, and the only one
 * that makes the guarantee hold by construction.
 *
 * ## The ordering, which is the whole design
 *
 * The re-mint happens on the restored copy BEFORE it is moved into place, and the
 * move is a `rename` (atomic on POSIX within a filesystem). So there is NO window
 * in which a restored database is live wearing an epoch that lies. Doing it the
 * obvious way round — copy over `podium.db`, then open it and re-mint — leaves
 * exactly that window, and a crash inside it produces the silent permanent
 * divergence above with no trace.
 *
 * The database being replaced is copied aside first, so the restore is itself
 * undoable — see {@link saveReplacedDatabase} for why that copy deliberately does
 * NOT go through `backupDatabase`.
 *
 * ## Invocation — NOT YET WIRED TO AN OPERATOR VERB
 *
 * {@link restoreCliMain} is the command-shaped entry (argv in, exit code out) and
 * is tested as such, but nothing dispatches to it yet: `podium <verb>` is resolved
 * in apps/cli, which is a separate package that may not import apps/server (it is
 * limited to @podium/protocol, @podium/model, @podium/runtime, @podium/issue-client),
 * so the verb has to arrive via the HostModules injection in scripts/cli.ts. That
 * wiring is tracked as its own issue.
 *
 * There is deliberately no `import.meta.main` self-exec block here. It would look
 * runnable and not be: production Podium ships as a `bun --compile` single binary
 * that carries no source tree, and in a git worktree without its own node_modules
 * a bare `bun run` on this file either fails to resolve `@podium/*` or — worse —
 * walks up and loads ANOTHER checkout's copy of them (the two-module-copies hazard
 * of POD-746). An entry point that resolves to the wrong build of @podium/sync is
 * exactly the kind of thing this file exists to prevent, not to reproduce.
 *
 * Until the verb lands, the bare file-copy restore remains the only operator path
 * and it silently keeps the old epoch — the gap ADR 2 D1 names. This module is the
 * fix; it needs one dispatch line to become reachable.
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { FeedIdentityRegistry, SyncRepository } from '@podium/sync'
import { freeDiskBytes } from './backup'

export interface RestoreReport {
  /** The backup that was restored. */
  backupPath: string
  /** The database file it now occupies. */
  dbPath: string
  /** Safety copy of the database that was REPLACED (undefined when the target
   *  did not exist, or held no tables worth copying). */
  replacedBackupPath: string | undefined
  /** The feed the restored database belongs to — unchanged by a restore: this
   *  is the same feed, on a new generation.
   *
   *  All three identity fields are null TOGETHER when the backup predates the
   *  feed-identity migration: there is no epoch to re-mint, and the next boot
   *  mints a fresh pair. See {@link remintRestoredEpoch}. */
  feedId: string | null
  /** The epoch as it sat in the backup — the generation clients may still hold
   *  cursors against, and precisely the one that must not be served again. */
  previousEpoch: string | null
  /** The freshly minted generation. Clients holding `previousEpoch` now see a
   *  mismatch on their next exchange and re-bootstrap (ADR 2 D7 rung 4). */
  epoch: string | null
}

export interface RestoreOptions {
  /** Backup file to restore (the `.backup-v…` main; sidecars are picked up). */
  backupPath: string
  /** Database file to replace. */
  dbPath: string
  /** Skip the safety backup of the database being replaced. Off by default —
   *  a restore is a rollback, and rollbacks get run twice. */
  skipSafetyBackup?: boolean
  /** Injected for tests. */
  freeBytes?: (dir: string) => number
  /** Injected for tests — must mint an opaque, never-reused id. */
  mint?: () => string
}

/**
 * Copy `backupPath` over `dbPath` and re-mint the feed epoch, in one step.
 *
 * Sequence, and why it is this one:
 *  1. Preflight the backup and free space — fail before touching anything.
 *  2. Safety-backup the CURRENT database, so this operation is undoable.
 *  3. Copy the backup to a temp sibling of the target.
 *  4. Open the TEMP copy, re-mint its epoch, checkpoint the WAL into the main
 *     file so the result is one self-contained file.
 *  5. Drop the target's stale sidecars and `rename` the temp into place.
 *
 * The re-mint (4) precedes the move (5): the database is never live with a stale
 * epoch, not even for a moment. A crash before (5) leaves the target untouched.
 */
export function restoreDatabase(opts: RestoreOptions): RestoreReport {
  const { backupPath, dbPath } = opts
  const freeBytes = opts.freeBytes ?? freeDiskBytes

  if (!existsSync(backupPath)) {
    throw new Error(`restore: backup not found: ${backupPath}`)
  }
  if (backupPath === dbPath) {
    throw new Error(`restore: backup and database are the same file: ${dbPath}`)
  }

  // Preflight (POD-615's lesson, applied to the other direction): a full disk
  // must fail loudly with numbers BEFORE a partial copy exists, not by dying
  // mid-write and leaving a truncated database where the real one was.
  const needed = sizeOf(backupPath) + sizeOf(`${backupPath}-wal`) + sizeOf(`${backupPath}-shm`)
  const targetDir = dirname(dbPath)
  const free = freeBytes(targetDir)
  if (free < needed * 1.1) {
    throw new Error(
      `restore: not enough free space in ${targetDir} — need ~${needed} bytes (+10% margin), have ${free}`,
    )
  }

  // The restore is a rollback, and rollbacks get re-run. Keep the database this
  // one replaces.
  let replacedBackupPath: string | undefined
  if (!opts.skipSafetyBackup && existsSync(dbPath)) {
    replacedBackupPath = saveReplacedDatabase(dbPath, freeBytes)
  }

  const tmpPath = `${dbPath}.restore-tmp`
  removeDbFiles(tmpPath)
  let report: Omit<RestoreReport, 'backupPath' | 'dbPath' | 'replacedBackupPath'>
  try {
    copyFileSync(backupPath, tmpPath)
    copyIfPresent(`${backupPath}-wal`, `${tmpPath}-wal`)
    copyIfPresent(`${backupPath}-shm`, `${tmpPath}-shm`)

    // THE re-mint, on the copy, before it is anywhere near live.
    const db = openDatabase(tmpPath)
    try {
      const minted = remintRestoredEpoch(db, opts.mint)
      // Fold the WAL back into the main file so what gets renamed into place is
      // one self-contained database and the sidecars we drop below are inert.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      report = minted
    } finally {
      db.close()
    }
  } catch (err) {
    removeDbFiles(tmpPath)
    throw err
  }

  // The target's sidecars belong to the database being replaced: a -wal left
  // beside the NEW main file would be replayed into it on next open, which is
  // corruption rather than a stale read. They go first, then the atomic rename.
  removeDbFiles(dbPath)
  renameSync(tmpPath, dbPath)
  // Checkpointed above, so these are empty if they exist at all.
  rmSync(`${tmpPath}-wal`, { force: true })
  rmSync(`${tmpPath}-shm`, { force: true })

  return { backupPath, dbPath, replacedBackupPath, ...report }
}

/** True when `name` is a table in this database. */
function hasTable(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  )
}

/**
 * Re-mint the restored database's epoch — unless the backup predates feed
 * identity entirely, in which case there is nothing to re-mint and saying so is
 * the correct answer.
 *
 * ## Why the missing table is the NORMAL case, not an edge case
 *
 * The feed-identity migration's own [spec:SP-4428] pre-migration backup is taken
 * BEFORE that migration runs — so the canonical artifact for rolling THIS change
 * back is a database with no `feed_identity` table at all. A restore path that only
 * handles post-migration backups fails exactly when the rollback it exists for is
 * being exercised. (Verified: without this branch, `SELECT ... FROM feed_identity`
 * throws `no such table` and the whole restore dies.)
 *
 * ## Why skipping is SAFE — the guarantee still holds
 *
 * A database with no `feed_identity` never issued an epoch, so no client can be
 * holding one from it. Its migration is still pending, so the next boot's
 * migrator creates the table and `Ledger`'s mint-on-construction assigns a FRESH
 * `(feedId, epoch)` — two brand-new minted ids that cannot collide with anything
 * any client holds. Every stale client therefore mismatches and re-bootstraps
 * (ADR 2 D7 rung 4), which is the outcome the re-mint exists to produce. There is
 * no window either: the file is not served until that boot, and the boot mints
 * before it serves.
 *
 * ## Why we must NOT just create the table here
 *
 * The tempting fix — `CREATE TABLE IF NOT EXISTS feed_identity` before re-minting —
 * is actively worse, and this is measured, not theorised. The restored database
 * has NOT applied `20260730181721_add-feed-identity-table`, so that migration is still pending; drizzle
 * runs it at the next boot and its `CREATE TABLE feed_identity` then fails with
 * "table feed_identity already exists". The result is a restored server that cannot
 * boot at all — trading a loud failure at restore time for a dead server during
 * the incident, after the operator has been told the restore succeeded.
 * Schema creation belongs to the migrator; the restore path only re-mints what
 * the migrator has already built.
 */
function remintRestoredEpoch(
  db: ReturnType<typeof openDatabase>,
  mint: (() => string) | undefined,
): { feedId: string | null; previousEpoch: string | null; epoch: string | null } {
  if (!hasTable(db, 'feed_identity')) {
    return { feedId: null, previousEpoch: null, epoch: null }
  }
  // POD-1246: this used `remintEpoch(new SyncRepository(db), mint)` from main's
  // `packages/sync/src/feed-identity.ts`. That module was retired in favour of
  // integration's `feed/identity.ts`, whose `FeedIdentityRegistry.bump()` is the
  // same operation with the refusal main's helper lacked — it throws if the mint
  // hands back the epoch it is replacing, which is the silent no-op that would
  // leave every replica applying a foreign timeline with no mismatch to catch.
  //
  // `'restore'` is not decoration: D1's hard case is that there is NO restore
  // code path to hook (a restore is `cp podium.db`), so the recorded cause is the
  // only evidence afterwards about which generation is which.
  const repo = new SyncRepository(db)
  const registry = new FeedIdentityRegistry(
    {
      readIdentity: () => repo.readFeedIdentity(),
      writeIdentity: (identity) => repo.writeFeedIdentity(identity, Date.now()),
    },
    mint ?? (() => randomUUID()),
  )
  const previous = registry.current()
  const next = registry.bump('restore')
  return { feedId: next.feedId, previousEpoch: previous.epoch, epoch: next.epoch }
}

/**
 * Copy the database about to be replaced to a timestamped sibling, and return
 * its path.
 *
 * Deliberately NOT `backupDatabase`, and this is the interesting decision here.
 * That function ends in `pruneBackups`, which keeps only
 * MIGRATION_BACKUPS_TO_KEEP (2) `<db>.backup-v*` files — matching on the prefix
 * alone, so EVERY label competes for the same two slots. Routing a restore's
 * safety copy through it has two bad consequences, the first of which a test
 * caught immediately:
 *
 *  - restoring the same backup twice deletes the backup being restored FROM
 *    (safety copy #2 evicts the oldest file in the pool — which is it); and
 *  - two restores evict every pre-migration backup, i.e. the restore command
 *    eats the very artifacts that ARE the sanctioned rollback path
 *    ([spec:SP-4428]), which is the exact opposite of its job.
 *
 * So the replaced database lands OUTSIDE that pool, under `.replaced-`, where
 * `isBackupMain` cannot see it: it neither prunes nor is pruned. It therefore
 * accumulates one file per restore, and that is the right trade — a restore is a
 * rare, deliberate operator action, and the file is precisely the thing they may
 * need back. Reclaiming it is the operator's call, not ours.
 */
function saveReplacedDatabase(dbPath: string, freeBytes: (dir: string) => number): string {
  // Fold the WAL into the main file so a plain copy is a consistent snapshot —
  // the same reason backupDatabase does it, and safe for the same reason (the
  // server is the single writer, and a restore runs with it stopped).
  const db = openDatabase(dbPath)
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }

  const needed = sizeOf(dbPath) + sizeOf(`${dbPath}-wal`) + sizeOf(`${dbPath}-shm`)
  const dir = dirname(dbPath)
  const free = freeBytes(dir)
  if (free < needed * 1.1) {
    throw new Error(
      `restore: not enough free space in ${dir} to save the database being replaced — ` +
        `need ~${needed} bytes (+10% margin), have ${free}`,
    )
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let dest = `${dbPath}.replaced-${stamp}`
  // Two restores inside one millisecond would otherwise silently overwrite the
  // first replaced database — the one file this function exists to keep.
  for (let n = 2; existsSync(dest); n++) dest = `${dbPath}.replaced-${stamp}-${n}`
  try {
    copyFileSync(dbPath, dest)
    copyIfPresent(`${dbPath}-wal`, `${dest}-wal`)
    copyIfPresent(`${dbPath}-shm`, `${dest}-shm`)
  } catch (err) {
    removeDbFiles(dest)
    throw err
  }
  return dest
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function copyIfPresent(from: string, to: string): void {
  if (existsSync(from)) copyFileSync(from, to)
}

function removeDbFiles(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
}

/** `restore <backup> [--db <path>]`. Returns a process exit code. */
export function restoreCliMain(argv: string[], stdout: (s: string) => void = console.log): number {
  // One left-to-right pass, so a flag's VALUE can never be mistaken for the
  // positional. (The tempting `args.find((a, i) => i !== args.indexOf('--db') + 1)`
  // is wrong precisely when --db is absent: indexOf returns -1, so it excludes
  // index 0 — the backup — and the command reports a usage error for a
  // perfectly good invocation.)
  //
  // Unknown flags are REFUSED, not skipped. Skipping them silently mis-parses the
  // value of any future value-taking flag as the backup path — `--label foo
  // backup.db` would restore "foo" — and this command's whole job is to overwrite
  // a database, so guessing at an argv it does not understand is the one thing it
  // must never do. Refusing is also what keeps `--db`'s value unreachable as a
  // positional.
  let dbPath: string | undefined = process.env.PODIUM_DB_PATH
  let backupPath: string | undefined
  let usageError: string | undefined
  for (let i = 0; i < argv.length && !usageError; i++) {
    const arg = argv[i] as string
    if (arg === '--db') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) usageError = '--db needs a path'
      else dbPath = value
      continue
    }
    if (arg === '--force') continue // accepted, no-op: reserved, and harmless to pass
    if (arg.startsWith('--')) {
      usageError = `unknown flag ${arg}`
      continue
    }
    if (backupPath !== undefined) usageError = `unexpected extra argument ${arg}`
    else backupPath = arg
  }
  if (usageError) {
    stdout(`restore: ${usageError}`)
    return 2
  }
  if (!backupPath || !dbPath) {
    stdout(
      'usage: restore <backup> --db <database>\n' +
        '  Copies <backup> over <database> and re-mints the feed epoch in one step\n' +
        '  (ADR 2 D1). The database being replaced is backed up first.\n' +
        '  --db may be omitted when PODIUM_DB_PATH is set.',
    )
    return 2
  }
  const r = restoreDatabase({ backupPath, dbPath })
  const identity =
    r.epoch === null
      ? '  feed    (this backup predates feed identity — the next boot mints a fresh\n' +
        '          feedId + epoch as the migration lands, so every stale client\n' +
        '          re-bootstraps. Nothing to re-mint here.)\n'
      : `  feed    ${r.feedId}\n  epoch   ${r.previousEpoch || '(none)'} → ${r.epoch}\n`
  stdout(
    `restored ${r.backupPath} → ${r.dbPath}\n` +
      identity +
      (r.replacedBackupPath ? `  replaced database saved to ${r.replacedBackupPath}\n` : '') +
      '  Clients holding a cursor on the previous epoch will re-bootstrap on reconnect.',
  )
  return 0
}
