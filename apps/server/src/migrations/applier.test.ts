/**
 * Applier unit tests [spec:SP-4428]: `runDrizzleMigrations` / `appliedDrizzleNames`
 * against SYNTHETIC migrations, so the behavior under test is the applier logic
 * itself, never the real
 * (60+ table) production schema — that convergence is covered separately in
 * convergence.test.ts. Every assertion reads the SCHEMA or the
 * `__drizzle_migrations` ledger back from SQLite; a bare return-value check is
 * never trusted on its own.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginMachineUpdateMigrations,
  MACHINE_UPDATE_GRANT_ENV,
  MachineUpdateExecutor,
  readMachineUpdateJournal,
  readAppliedUpdateMigrations,
} from '@podium/runtime/machine-update'
import { rollbackDecision } from '@podium/runtime/parent-supervisor'
import { migrateStoreConnection } from './store-lifecycle'
import { appliedDrizzleNames, type DrizzleMigration, runDrizzleMigrations } from './index'

const A: DrizzleMigration = {
  name: '20260101000000_a',
  sql: 'CREATE TABLE a (id TEXT PRIMARY KEY);',
}
const B: DrizzleMigration = {
  name: '20260101000001_b',
  sql: 'CREATE TABLE b (id TEXT PRIMARY KEY);',
}
const C: DrizzleMigration = {
  name: '20260101000002_c',
  sql: 'CREATE TABLE c (id TEXT PRIMARY KEY);',
}

function hasTable(db: SqlDatabase, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  )
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
function tmpDbFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'podium-applier-'))
  roots.push(root)
  return join(root, name)
}

describe('runDrizzleMigrations', () => {
  it('fresh apply: builds the tables and writes matching __drizzle_migrations rows', () => {
    const db = openDatabase(':memory:')
    const applied = runDrizzleMigrations(db, [A, B, C])

    expect(applied).toEqual([A.name, B.name, C.name])
    expect(hasTable(db, 'a')).toBe(true)
    expect(hasTable(db, 'b')).toBe(true)
    expect(hasTable(db, 'c')).toBe(true)
    expect(appliedDrizzleNames(db)).toEqual(new Set([A.name, B.name, C.name]))
    db.close()
  })

  it('idempotent: a second run applies nothing and leaves the ledger unchanged', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, [A, B, C])
    const before = appliedDrizzleNames(db)

    const second = runDrizzleMigrations(db, [A, B, C])

    expect(second).toEqual([])
    expect(appliedDrizzleNames(db)).toEqual(before)
    db.close()
  })

  it('accepts the deployed pre-rebase enrollment migration name without replaying its SQL', () => {
    const db = openDatabase(':memory:')
    const canonical: DrizzleMigration = {
      name: '20260724134702_session-spawn-failure',
      sql: 'ALTER TABLE a ADD COLUMN spawn_failure TEXT;',
    }
    runDrizzleMigrations(db, [A, canonical])
    db.prepare('UPDATE __drizzle_migrations SET name = ? WHERE name = ?').run(
      '20260722210552_session-spawn-failure',
      canonical.name,
    )

    const applied = runDrizzleMigrations(db, [A, canonical])

    expect(applied).toEqual([])
    expect(appliedDrizzleNames(db)).toEqual(
      new Set([A.name, '20260722210552_session-spawn-failure']),
    )
    expect(db.prepare('SELECT spawn_failure FROM a LIMIT 1').all()).toEqual([])
    db.close()
  })

  it('#472 back-fill: a DB that applied A and C (not B) applies exactly B, regardless of position', () => {
    const db = openDatabase(':memory:')
    // Build a DB that has a hole at B — the scenario #472 exists to guard
    // against (a migration applied by NAME set membership, not by counting).
    runDrizzleMigrations(db, [A, C])
    expect(hasTable(db, 'b')).toBe(false)
    expect(appliedDrizzleNames(db)).toEqual(new Set([A.name, C.name]))

    const applied = runDrizzleMigrations(db, [A, B, C])

    expect(applied).toEqual([B.name])
    expect(hasTable(db, 'b')).toBe(true)
    expect(appliedDrizzleNames(db)).toEqual(new Set([A.name, B.name, C.name]))
    db.close()
  })

  it('downgrade guard: a DB ahead of the given migration set throws and touches nothing', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, [A, B, C])
    const before = appliedDrizzleNames(db)

    expect(() => runDrizzleMigrations(db, [A, B])).toThrow(/newer than this build/i)
    // The guard fires before any backup/migrate work — ledger is byte-for-byte
    // what it was.
    expect(appliedDrizzleNames(db)).toEqual(before)
    db.close()
  })

  it('one-transaction batch: a bad migration rolls back the WHOLE pending batch', () => {
    const db = openDatabase(':memory:')
    const BAD: DrizzleMigration = {
      name: '20260101000001_bad',
      sql: 'THIS IS NOT VALID SQL AT ALL',
    }

    expect(() => runDrizzleMigrations(db, [A, BAD, C])).toThrow()

    // drizzle applies the whole pending set in ONE transaction: A's CREATE
    // TABLE ran (in name order) before BAD's failure, but the ROLLBACK undoes
    // the entire batch — nothing from it partially commits.
    expect(hasTable(db, 'a')).toBe(false)
    expect(hasTable(db, 'c')).toBe(false)
    expect(appliedDrizzleNames(db)).toEqual(new Set())
    db.close()
  })

  it('backup (#43): an empty file gets no backup; an advancing one does', () => {
    const file = tmpDbFile('applier.db')
    const dir = dirname(file)
    const db = openDatabase(file)
    const backupsIn = () => readdirSync(dir).filter((n) => n.includes('.backup-v'))

    // First apply: the file is brand new (no real tables yet) — not worth
    // backing up.
    runDrizzleMigrations(db, [A], { dbPath: file })
    expect(backupsIn()).toEqual([])

    // Second apply: the DB now holds a real table (`a`) and is advancing —
    // #43's pre-migration snapshot fires.
    runDrizzleMigrations(db, [A, B], { dbPath: file })
    expect(backupsIn().length).toBeGreaterThan(0)

    db.close()
  })
})

describe('per-grant migration execution receipts', () => {
  async function updateFixture() {
    const dbPath = tmpDbFile('podium.db')
    const runtimeDir = join(dirname(dbPath), 'runtime')
    const executor = new MachineUpdateExecutor({
      runtimeDir,
      adapter: {
        runningVersion: () => '1.0.0',
        prepare: async () => ({ digest: 'new', releaseHadMigrations: true }),
        activate: async () => {},
        restart: async () => 'handover-pending',
        discard: async () => {},
      },
      report: () => {},
    })
    await executor.accept({
      type: 'updateGrant',
      grantId: 'server-update',
      issuedAt: 1,
      target: { version: '2.0.0', critical: false, artifacts: {} },
    })
    return { dbPath, runtimeDir, executor, update: { runtimeDir, grantId: 'server-update' } }
  }

  it('records only this run, and the parent refuses with the applied ID', async () => {
    const { dbPath, runtimeDir, executor, update } = await updateFixture()
    const db = openDatabase(dbPath)
    try {
      runDrizzleMigrations(db, [A])
      runDrizzleMigrations(db, [A, B], { dbPath, update })
      const entries = [{ id: B.name, appliedAt: expect.any(Number) }]
      expect(executor.snapshot()?.appliedMigrations).toEqual(entries)
      runDrizzleMigrations(db, [A, B], { dbPath, update })
      const appliedMigrations = readMachineUpdateJournal(runtimeDir)?.appliedMigrations
      expect(appliedMigrations).toEqual(entries)
      const decision = rollbackDecision({
        crashLoop: true,
        oldBundlePresent: true,
        appliedMigrations,
      })
      expect(decision).toEqual({ action: 'unavailable', why: expect.stringContaining(B.name) })
    } finally {
      db.close()
    }
  })

  it('a failed transaction records nothing and leaves rollback available', async () => {
    const { dbPath, runtimeDir, update } = await updateFixture()
    const db = openDatabase(dbPath)
    try {
      expect(() =>
        runDrizzleMigrations(db, [A, { ...B, sql: 'INVALID SQL' }], { dbPath, update }),
      ).toThrow()
      expect(appliedDrizzleNames(db)).toEqual(new Set())
      const appliedMigrations = readMachineUpdateJournal(runtimeDir)?.appliedMigrations
      expect(appliedMigrations).toEqual([])
      expect(
        rollbackDecision({ crashLoop: true, oldBundlePresent: true, appliedMigrations }),
      ).toEqual({ action: 'rollback' })
    } finally {
      db.close()
    }
  })

  it('publishes committed IDs even if post-migration boot work throws', async () => {
    const { dbPath, runtimeDir, update } = await updateFixture()
    const db = openDatabase(dbPath)
    const migration = { name: '20260917185720_session-delegation-record', sql: A.sql }
    try {
      // The post-migration diagnostic needs sessions; this synthetic DB lacks it.
      expect(() => runDrizzleMigrations(db, [migration], { dbPath, update })).toThrow()
      expect(appliedDrizzleNames(db)).toEqual(new Set([migration.name]))
      expect(readMachineUpdateJournal(runtimeDir)?.appliedMigrations).toEqual([
        { id: migration.name, appliedAt: expect.any(Number) },
      ])
    } finally {
      db.close()
    }
  })

  it.each([
    false,
    true,
  ])('recovers actual commit state after interrupted receipt publication (committed=%s)', async (committed) => {
    const { dbPath, runtimeDir, update } = await updateFixture()
    const db = openDatabase(dbPath)
    try {
      // Simulate death after intent, either before SQL or after SQLite committed.
      beginMachineUpdateMigrations(runtimeDir, update.grantId, dbPath, [A.name], 123)
      if (committed) runDrizzleMigrations(db, [A])
    } finally {
      db.close()
    }
    expect(readAppliedUpdateMigrations(runtimeDir, update.grantId)).toEqual(
      committed ? [{ id: A.name, appliedAt: 123 }] : [],
    )
  })

  it('the server records against its inherited installed grant, not a later queued update', async () => {
    const { dbPath, runtimeDir } = await updateFixture()
    vi.stubEnv('PODIUM_STATE_DIR', dirname(dbPath))
    vi.stubEnv(MACHINE_UPDATE_GRANT_ENV, 'installed-grant')
    const db = openDatabase(dbPath)
    try {
      const applied = migrateStoreConnection(db, dbPath)
      expect(applied.length).toBeGreaterThan(0)
      expect(
        readAppliedUpdateMigrations(runtimeDir, 'installed-grant').map((entry) => entry.id),
      ).toEqual(applied)
      expect(readMachineUpdateJournal(runtimeDir)?.appliedMigrations).toEqual([])
    } finally {
      db.close()
    }
  })

  it('the production store boot discovers the current grant and records its migrations', async () => {
    const { dbPath, runtimeDir } = await updateFixture()
    vi.stubEnv('PODIUM_STATE_DIR', dirname(dbPath))
    const db = openDatabase(dbPath)
    try {
      const applied = migrateStoreConnection(db, dbPath)
      expect(applied.length).toBeGreaterThan(0)
      expect(
        readMachineUpdateJournal(runtimeDir)?.appliedMigrations.map((entry) => entry.id),
      ).toEqual(applied)
      expect(migrateStoreConnection(db, dbPath)).toEqual([])
      expect(
        readMachineUpdateJournal(runtimeDir)?.appliedMigrations.map((entry) => entry.id),
      ).toEqual(applied)
    } finally {
      db.close()
    }
  })
})
