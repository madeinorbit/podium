/**
 * Restore + epoch re-mint (ADR 2 D1) over the REAL migration chain, the REAL
 * SQLite files and the REAL Ledger — nothing here is stubbed but the free-space
 * probe, because the property under test is precisely what survives a file being
 * copied over another one.
 *
 * The headline test reproduces the hole D1 exists to close, and no current test
 * could catch: restore → keep writing → a stale client reconnects at a cursor
 * whose seq is perfectly valid on a timeline that no longer exists.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { Ledger, SyncRepository } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { backupDatabase } from './backup'
import { applyBaselineSchema } from './index'
import { restoreCliMain, restoreDatabase } from './restore'

const PLENTY = () => Number.MAX_SAFE_INTEGER

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A file-backed authority on the real drizzle schema. */
function authority(): { db: SqlDatabase; dbPath: string; dir: string; ledger: LedgerWithIdentity } {
  const dir = mkdtempSync(join(tmpdir(), 'podium-restore-'))
  dirs.push(dir)
  const dbPath = join(dir, 'podium.sqlite')
  const db = openDatabase(dbPath)
  applyBaselineSchema(db)
  return { db, dbPath, dir, ledger: ledgerOver(db) }
}

/**
 * POD-1246: main's `Ledger` carried a `feedIdentity()` method; this branch keeps
 * feed identity on the repository (`SyncRepository.readFeedIdentity`) rather than
 * on the ledger. The test's assertions are unchanged — only where they read the
 * identity from. The throw is deliberate: every call site here has already written
 * an identity, so a null means the restore under test lost it, which is the thing
 * these cases exist to catch.
 */
type LedgerWithIdentity = Ledger & { feedIdentity: () => { feedId: string; epoch: string } }

function ledgerOver(db: SqlDatabase): LedgerWithIdentity {
  const ledger = new Ledger({
    repo: new SyncRepository(db),
    now: () => 1_000,
    transact: (fn) => transaction(db, fn),
  }) as LedgerWithIdentity
  ledger.feedIdentity = () => {
    const identity = new SyncRepository(db).readFeedIdentity()
    if (!identity) throw new Error('no feed identity on this database')
    return identity
  }
  return ledger
}

/** Append `n` distinct issue upserts, returning the ledger's cursor after them. */
function write(ledger: Ledger, ids: string[]): number {
  for (const id of ids) {
    ledger.commit({
      write: () => undefined,
      changes: () => [{ entity: 'issue', id, op: 'upsert', value: { id, title: id } }],
    })
  }
  return ledger.cursor()
}

/** True when `name` is a table in this database. */
function hasTable(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  )
}

/** Column names of `table`, straight from sqlite. */
function columnNames(db: SqlDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

describe('the migration creates the feed-identity table', () => {
  it('sync_feed exists on a freshly migrated database and the Ledger mints into it', () => {
    // If the migration did not ship the table, the Ledger's mint would throw on
    // first boot — so this pins the migration and the mint together.
    const { db, ledger } = authority()
    const identity = ledger.feedIdentity()
    expect(identity.feedId).toBeTruthy()
    expect(identity.epoch).toBeTruthy()
    expect(new SyncRepository(db).readFeedIdentity()).toEqual(identity)
  })

  it('sync_feed refuses a second row — one database is one feed', () => {
    const { db } = authority()
    expect(() =>
      db.prepare('INSERT INTO sync_feed (id, feed_id, epoch) VALUES (2, ?, ?)').run('f', 'e'),
    ).toThrow()
  })
})

describe('restore re-mints the epoch (ADR 2 D1)', () => {
  it('closes the hole: a restored authority that writes PAST a stale cursor would otherwise answer "up to date" forever', () => {
    // ---- Act 1: a healthy authority, and a client that keeps up. --------------
    const { db, dbPath, ledger } = authority()
    const beforeBackup = write(ledger, ['iss_1', 'iss_2'])
    expect(beforeBackup).toBe(2)

    // The sanctioned rollback point ([spec:SP-4428]: drizzle has no down
    // migrations, so restoring the pre-migration backup IS the rollback).
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')

    // The authority writes on. The client reads all of it and parks its cursor.
    const clientCursor = write(ledger, ['iss_3', 'iss_4'])
    const clientFeedId = ledger.feedIdentity().feedId
    const clientEpoch = ledger.feedIdentity().epoch
    expect(clientCursor).toBe(4)
    db.close()

    // ---- Act 2: the rollback. -----------------------------------------------
    const restored = restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })
    const db2 = openDatabase(dbPath)
    const ledger2 = ledgerOver(db2)
    // The log really did rewind: the client's cursor is now in the future.
    expect(ledger2.cursor()).toBe(2)

    // ---- Act 3: the authority keeps working, and max catches back up. --------
    // This is the step that makes the hole permanent rather than transient. Ask
    // during the window and `cursor > max` would have healed by luck; wait until
    // the seqs are reused and the heuristic goes quiet.
    const rewritten = write(ledger2, ['iss_5', 'iss_6'])
    expect(rewritten).toBe(clientCursor) // 4 again — a DIFFERENT 4

    // ---- The hole, demonstrated. --------------------------------------------
    // On seq alone the authority says "you are up to date". The client is NOT:
    // it holds iss_3/iss_4 from a timeline that no longer exists, and it never
    // saw iss_5/iss_6 of the one that does. Nothing about this answer is
    // detectable by a replica holding a bare integer.
    expect(ledger2.changesSince(clientCursor)).toEqual([])

    // ---- The close. ---------------------------------------------------------
    // The epoch is the entire difference: one equality check on the next
    // exchange and the client re-bootstraps (ADR 2 D7 rung 4).
    expect(ledger2.feedIdentity().epoch).not.toBe(clientEpoch)
    expect(restored.previousEpoch).toBe(clientEpoch)
    expect(restored.epoch).toBe(ledger2.feedIdentity().epoch)
    // Same database, same feed — only the generation moved. A changed feedId
    // would say "different feed entirely", which is a different (wrong) claim.
    expect(ledger2.feedIdentity().feedId).toBe(clientFeedId)
    expect(restored.feedId).toBe(clientFeedId)
    db2.close()
  })

  it('restoring the SAME backup twice yields two DIFFERENT epochs', () => {
    // The anti-counter property, end to end. A counter re-derives the epoch from
    // the restored (old) value and maps it to the same successor every time — so
    // a second rollback attempt, a re-run runbook, or a botched first restore
    // hands a different timeline an epoch clients already accepted. Silently, in
    // exactly the situation the epoch exists to catch.
    const { db, dbPath, ledger } = authority()
    write(ledger, ['iss_1'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    const backupEpoch = ledger.feedIdentity().epoch
    db.close()

    const first = restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })
    const second = restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })

    expect(first.previousEpoch).toBe(backupEpoch)
    // The second restore re-presents the SAME stored epoch to the bump...
    expect(second.previousEpoch).toBe(backupEpoch)
    // ...and must still not produce the first restore's epoch.
    expect(second.epoch).not.toBe(first.epoch)
    expect(first.epoch).not.toBe(backupEpoch)
    expect(second.epoch).not.toBe(backupEpoch)
    // Both are the same feed throughout.
    expect(second.feedId).toBe(first.feedId)
  })

  it('the re-mint is durable in the file that lands in place, not just in the report', () => {
    // The report is not evidence: what matters is the epoch a NEXT boot reads.
    const { db, dbPath, ledger } = authority()
    write(ledger, ['iss_1'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    db.close()

    const r = restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })
    const db2 = openDatabase(dbPath)
    expect(new SyncRepository(db2).readFeedIdentity()).toEqual({
      feedId: r.feedId,
      epoch: r.epoch,
    })
    db2.close()
  })

  it('the backup file itself is left untouched — it stays restorable', () => {
    const { db, dbPath, ledger } = authority()
    write(ledger, ['iss_1'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    const backupEpoch = ledger.feedIdentity().epoch
    db.close()

    restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })

    // The re-mint happens on the COPY. A backup mutated in place would be
    // single-use, and the second rollback attempt would find a lie.
    const backupDb = openDatabase(backupPath)
    expect(new SyncRepository(backupDb).readFeedIdentity()?.epoch).toBe(backupEpoch)
    backupDb.close()
  })

  it('keeps a safety backup of the database it replaced — a rollback is itself rollback-able', () => {
    const { db, dbPath, dir, ledger } = authority()
    write(ledger, ['iss_1'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    write(ledger, ['iss_2', 'iss_3'])
    db.close()

    const r = restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })
    expect(r.replacedBackupPath).toBeTruthy()
    expect(readdirSync(dir)).toContain(r.replacedBackupPath?.split('/').pop())

    // The replaced database still holds what the restore discarded.
    const saved = openDatabase(r.replacedBackupPath as string)
    expect(ledgerOver(saved).cursor()).toBe(3)
    saved.close()
  })

  it('leaves the target untouched when the copy cannot proceed', () => {
    const { db, dbPath, ledger } = authority()
    const cursorBefore = write(ledger, ['iss_1', 'iss_2'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    const epochBefore = ledger.feedIdentity().epoch
    db.close()

    // A full disk must fail BEFORE anything is written, with numbers — never by
    // dying mid-copy and leaving a truncated database where the real one was
    // (POD-615's lesson, pointed the other way).
    expect(() => restoreDatabase({ backupPath, dbPath, freeBytes: () => 1 })).toThrow(
      /not enough free space/,
    )

    const db2 = openDatabase(dbPath)
    expect(ledgerOver(db2).cursor()).toBe(cursorBefore)
    expect(new SyncRepository(db2).readFeedIdentity()?.epoch).toBe(epochBefore)
    db2.close()
  })

  it('refuses a missing backup, and refuses to restore a file over itself', () => {
    const { dbPath } = authority()
    expect(() =>
      restoreDatabase({ backupPath: `${dbPath}.nope`, dbPath, freeBytes: PLENTY }),
    ).toThrow(/backup not found/)
    expect(() => restoreDatabase({ backupPath: dbPath, dbPath, freeBytes: PLENTY })).toThrow(
      /same file/,
    )
  })

  it('never consumes the backup pool: the backup being restored, and the pre-migration backups, all survive', () => {
    // Regression, found by the two-restores test above. The safety copy used to
    // go through backupDatabase, whose pruneBackups keeps only the 2 newest
    // `<db>.backup-v*` files — matching the PREFIX, so every label shares two
    // slots. Restoring twice therefore deleted the backup being restored from,
    // and would have evicted the pre-migration backups that ARE the sanctioned
    // rollback path: the restore command eating its own inputs.
    const { db, dbPath, dir, ledger } = authority()
    write(ledger, ['iss_1'])
    // Two pre-migration backups — the full pool, exactly as a migrated server has.
    const migrationBackups = [
      backupDatabase(db, dbPath, 'drizzle-1', PLENTY),
      backupDatabase(db, dbPath, 'drizzle-2', PLENTY),
    ]
    const target = migrationBackups[0]
    if (!target || !migrationBackups[1]) throw new Error('backups did not run')
    db.close()

    // Restore the OLDEST backup, three times over.
    for (let i = 0; i < 3; i++) restoreDatabase({ backupPath: target, dbPath, freeBytes: PLENTY })

    const present = readdirSync(dir)
    for (const b of migrationBackups) {
      expect(present).toContain((b as string).split('/').pop())
    }
    // And each restore kept the database it replaced.
    expect(present.filter((n) => n.includes('.replaced-'))).toHaveLength(3)
  })

  it('leaves no temp files behind', () => {
    const { db, dbPath, dir, ledger } = authority()
    write(ledger, ['iss_1'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    db.close()
    restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })
    expect(readdirSync(dir).filter((n) => n.includes('restore-tmp'))).toEqual([])
  })
})

describe('restoreCliMain (the command-shaped entry)', () => {
  const run = (argv: string[]): { code: number; out: string } => {
    const lines: string[] = []
    const code = restoreCliMain(argv, (s) => lines.push(s))
    return { code, out: lines.join('\n') }
  }

  it('restores, re-mints, and reports both epochs to the operator', () => {
    const { db, dbPath, ledger } = authority()
    write(ledger, ['iss_1'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    const before = ledger.feedIdentity().epoch
    db.close()

    const { code, out } = run([backupPath, '--db', dbPath])
    expect(code).toBe(0)
    // The operator must be able to SEE that the generation moved — this output is
    // the only feedback that the guarantee actually fired.
    expect(out).toContain(before)
    const db2 = openDatabase(dbPath)
    const after = new SyncRepository(db2).readFeedIdentity()?.epoch as string
    db2.close()
    expect(after).not.toBe(before)
    expect(out).toContain(after)
    expect(out).toContain('re-bootstrap')
  })

  it('prints usage and exits non-zero when the database is not given', () => {
    const prev = process.env.PODIUM_DB_PATH
    delete process.env.PODIUM_DB_PATH
    try {
      const { code, out } = run(['/some/backup'])
      expect(code).toBe(2)
      expect(out).toContain('usage:')
    } finally {
      if (prev !== undefined) process.env.PODIUM_DB_PATH = prev
    }
  })

  it('accepts --db on either side of the backup, and tolerates --force', () => {
    // Regression: parsing that located the positional by excluding
    // `indexOf('--db') + 1` excluded index 0 whenever --db was ABSENT (-1 + 1),
    // rejecting a valid `restore <backup>` with a usage error.
    const { db, dbPath, ledger } = authority()
    write(ledger, ['iss_1'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    db.close()
    for (const argv of [
      [backupPath, '--db', dbPath],
      ['--db', dbPath, backupPath],
      ['--force', backupPath, '--db', dbPath],
    ]) {
      expect(run(argv).code).toBe(0)
    }
  })

  it('takes the database from PODIUM_DB_PATH when --db is omitted', () => {
    const { db, dbPath, ledger } = authority()
    write(ledger, ['iss_1'])
    const backupPath = backupDatabase(db, dbPath, 'test', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    db.close()
    const prev = process.env.PODIUM_DB_PATH
    process.env.PODIUM_DB_PATH = dbPath
    try {
      expect(run([backupPath]).code).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.PODIUM_DB_PATH
      else process.env.PODIUM_DB_PATH = prev
    }
  })
})

/**
 * A backup that predates the feed-identity migration. This is NOT an exotic case:
 * the [spec:SP-4428] pre-migration backup for 20260717092407 is taken BEFORE it
 * runs, so the canonical artifact for rolling THIS change back has no sync_feed
 * table and still has the migration pending.
 */
describe('restoring a backup from before feed identity existed', () => {
  /**
   * A database exactly as it looked before 20260717092407 — every effect of that
   * migration undone, and its ledger row removed so it is genuinely PENDING.
   *
   * Both effects must go, not just the table: a first draft dropped only
   * sync_feed and left `issues.revision` behind, and the re-applied migration
   * then died on "duplicate column name: revision". That was the fixture lying,
   * not the product — but it is worth keeping the whole undo explicit, because a
   * half-undone fixture silently tests a state no backup can actually be in.
   */
  function preFeedIdentityAuthority(): { db: SqlDatabase; dbPath: string; dir: string } {
    const { db, dbPath, dir } = authority()
    db.exec('DROP TABLE sync_feed')
    db.exec('ALTER TABLE issues DROP COLUMN revision')
    db.prepare(
      "DELETE FROM __drizzle_migrations WHERE name LIKE '%issue-revision-and-feed-identity%'",
    ).run()
    return { db, dbPath, dir }
  }

  it('the fixture is faithful: the migration really is pending and re-appliable', () => {
    // Guards the tests below from passing for the wrong reason. If this fixture
    // drifts from what a real pre-migration backup looks like, everything after
    // it is theatre.
    const { db, dbPath } = preFeedIdentityAuthority()
    expect(hasTable(db, 'sync_feed')).toBe(false)
    expect(columnNames(db, 'issues')).not.toContain('revision')
    db.close()
    const reopened = openDatabase(dbPath)
    expect(applyBaselineSchema(reopened)).toContain(
      '20260717092407_issue-revision-and-feed-identity',
    )
    expect(hasTable(reopened, 'sync_feed')).toBe(true)
    expect(columnNames(reopened, 'issues')).toContain('revision')
    reopened.close()
  })

  it('restores instead of dying, and reports honestly that there was nothing to re-mint', () => {
    const { db, dbPath } = preFeedIdentityAuthority()
    const backupPath = backupDatabase(db, dbPath, 'pre-feed', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    db.close()

    const r = restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })
    // All three identity fields are null TOGETHER — a database that never issued
    // an epoch has none to re-mint, and inventing one here would be a lie.
    expect(r).toMatchObject({ feedId: null, previousEpoch: null, epoch: null })
  })

  it('the restored file still BOOTS, and the boot mints a fresh identity', () => {
    // The regression that matters. The obvious fix for the test above — have
    // restore CREATE TABLE IF NOT EXISTS sync_feed — passes it and breaks THIS:
    // the restored database has not applied 20260717092407, so drizzle runs it at
    // boot and its CREATE TABLE collides with the pre-created one ("table
    // sync_feed already exists"). That turns a loud restore-time failure into a
    // server that cannot start, during the incident, after the operator has been
    // told the restore worked. Schema creation is the migrator's job.
    const { db, dbPath } = preFeedIdentityAuthority()
    const backupPath = backupDatabase(db, dbPath, 'pre-feed', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    db.close()

    restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })

    const booted = openDatabase(dbPath)
    // The pending migration applies cleanly...
    expect(() => applyBaselineSchema(booted)).not.toThrow()
    // ...and the Ledger's mint-on-construction gives the feed an identity.
    const identity = ledgerOver(booted).feedIdentity()
    expect(identity.feedId).toBeTruthy()
    expect(identity.epoch).toBeTruthy()
    booted.close()
  })

  it('the identity the boot mints is FRESH, so every stale client still re-bootstraps', () => {
    // The guarantee, via the other door. No re-mint happened at restore time, so
    // this is what actually protects a client holding a cursor from the timeline
    // that was rolled back.
    const { db, dbPath, ledger } = authority()
    const staleFeedId = ledger.feedIdentity().feedId
    const staleEpoch = ledger.feedIdentity().epoch
    write(ledger, ['iss_1'])
    db.close()

    // A backup of the pre-migration world, restored over that live database.
    const { db: old, dbPath: oldPath } = preFeedIdentityAuthority()
    const backupPath = backupDatabase(old, oldPath, 'pre-feed', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    old.close()

    restoreDatabase({ backupPath, dbPath, freeBytes: PLENTY })
    const booted = openDatabase(dbPath)
    applyBaselineSchema(booted)
    const fresh = ledgerOver(booted).feedIdentity()
    // Minted ids, so they cannot collide with what the client holds — on EITHER
    // field. Mismatch -> discard the replica -> re-bootstrap (ADR 2 D7 rung 4).
    expect(fresh.feedId).not.toBe(staleFeedId)
    expect(fresh.epoch).not.toBe(staleEpoch)
    booted.close()
  })

  it('restoreCliMain says so rather than printing nulls at the operator', () => {
    const { db, dbPath } = preFeedIdentityAuthority()
    const backupPath = backupDatabase(db, dbPath, 'pre-feed', PLENTY)
    if (!backupPath) throw new Error('backup did not run')
    db.close()
    const lines: string[] = []
    const code = restoreCliMain([backupPath, '--db', dbPath], (s) => lines.push(s))
    const out = lines.join('\n')
    expect(code).toBe(0)
    expect(out).toContain('predates feed identity')
    expect(out).not.toContain('null')
  })
})

describe('restoreCliMain refuses argv it does not understand', () => {
  const run = (argv: string[]): { code: number; out: string } => {
    const lines: string[] = []
    const code = restoreCliMain(argv, (s) => lines.push(s))
    return { code, out: lines.join('\n') }
  }

  it('rejects an unknown flag rather than mis-parsing its value as the backup', () => {
    // Skipping unknown flags silently made `--label foo backup.db` restore "foo".
    // This command overwrites a database; guessing at an argv it does not
    // understand is the one thing it must never do.
    const { code, out } = run(['--label', 'foo', '/b.db', '--db', '/db.sqlite'])
    expect(code).toBe(2)
    expect(out).toContain('unknown flag --label')
  })

  it('rejects a second positional', () => {
    const { code, out } = run(['/a.db', '/b.db', '--db', '/db.sqlite'])
    expect(code).toBe(2)
    expect(out).toContain('unexpected extra argument /b.db')
  })

  it('rejects --db with no value instead of swallowing the next flag', () => {
    const { code, out } = run(['/a.db', '--db', '--force'])
    expect(code).toBe(2)
    expect(out).toContain('--db needs a path')
  })
})
