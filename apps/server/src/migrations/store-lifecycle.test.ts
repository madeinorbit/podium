import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { probeStatements, type StatementProbeHolder } from '../store/executor'
import { openTestStore } from '../test-support/open-test-store'
import { runDrizzleMigrations } from './index'
import { migrateStoreConnection, withMigrationForeignKeysDisabled } from './store-lifecycle'

const rebuild = [
  {
    name: '20990101000000_rebuild',
    sql: [
      'PRAGMA foreign_keys = OFF;',
      'CREATE TABLE new_parent (id INTEGER PRIMARY KEY);',
      'INSERT INTO new_parent SELECT * FROM parent;',
      'DROP TABLE parent;',
      'ALTER TABLE new_parent RENAME TO parent;',
      'PRAGMA foreign_keys = ON;',
    ].join('\n--> statement-breakpoint\n'),
  },
]

function fixture() {
  const db = openDatabase(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
  db.exec('CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))')
  db.exec('INSERT INTO parent VALUES (1)')
  db.exec('INSERT INTO child VALUES (1)')
  return db
}

function engineRefusal(run: () => unknown): () => unknown {
  return () => {
    try {
      return run()
    } catch (error) {
      let cause: unknown = error
      while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause
      throw cause
    }
  }
}

describe('migration connection bracket', () => {
  it('refuses a rebuild with enforcement on despite OFF inside drizzle transaction', () => {
    const db = fixture()
    try {
      expect(
        engineRefusal(() => runDrizzleMigrations(db, rebuild, { skipSchemaRepair: true })),
      ).toThrow(/FOREIGN KEY constraint failed/)
      expect(db.prepare('SELECT * FROM child').all()).toEqual([{ parent_id: 1 }])
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    } finally {
      db.close()
    }
  })

  it('preserves children when the bracket and migrator share the connection', () => {
    const db = fixture()
    try {
      withMigrationForeignKeysDisabled(db, () =>
        runDrizzleMigrations(db, rebuild, { skipSchemaRepair: true }),
      )
      expect(db.prepare('SELECT * FROM child').all()).toEqual([{ parent_id: 1 }])
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(() => db.exec('INSERT INTO child VALUES (2)')).toThrow(/FOREIGN KEY constraint failed/)
    } finally {
      db.close()
    }
  })

  it('a bracket on another connection does not protect the rebuild', () => {
    const db = fixture()
    const wrong = fixture()
    try {
      expect(
        engineRefusal(() =>
          withMigrationForeignKeysDisabled(wrong, () =>
            runDrizzleMigrations(db, rebuild, { skipSchemaRepair: true }),
          ),
        ),
      ).toThrow(/FOREIGN KEY constraint failed/)
      expect(wrong.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    } finally {
      db.close()
      wrong.close()
    }
  })
})


// A page first written inside a savepoint is copied to the sub-journal, which
// spills to a temp file past 64 KiB [POD-6232]. The file is unlinked as it is
// created, so it shows only as an open descriptor named etilqs_… (deleted).
// The bare connection is the control: the same write must spill there.
describe.skipIf(process.platform !== 'linux')('temp store: memory for traffic, file for migrations and maintenance', () => {
  const cleanup: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step()
  })

  function scratchPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'podium-store-lifecycle-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    return join(dir, 'podium.db')
  }

  async function fileStore(): Promise<{ store: SessionStore; database: SqlDatabase }> {
    const store = await openTestStore(scratchPath())
    cleanup.push(() => store.close())
    return { store, database: (store as unknown as { db: SqlDatabase }).db }
  }

  const tempStore = (db: SqlDatabase) => (db.prepare('PRAGMA temp_store').get() as { temp_store: number }).temp_store

  /** Rewrite about 64 committed pages inside a savepoint; the temp files open meanwhile. */
  function tempFilesDuringSavepointWrite(db: SqlDatabase): string[] {
    db.exec('CREATE TABLE spill_rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    db.exec('BEGIN')
    for (let id = 0; id < 256; id++) db.prepare('INSERT INTO spill_rows VALUES (?, ?)').run(id, 'x'.repeat(900))
    db.exec('COMMIT')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('SAVEPOINT outer_write')
      db.exec("UPDATE spill_rows SET body = body || 'y'")
      return readdirSync('/proc/self/fd').flatMap((fd) => {
        try {
          const target = readlinkSync(`/proc/self/fd/${fd}`)
          return target.includes('etilqs_') && target.endsWith('(deleted)') ? [target] : []
        } catch {
          return []
        }
      })
    } finally {
      db.exec('ROLLBACK')
    }
  }

  it('a migration connection keeps temp files on disk, so a large savepoint journal spills', () => {
    const db = openDatabase(scratchPath())
    try {
      migrateStoreConnection(db, ':memory:')
      expect(tempStore(db)).toBe(0)
      expect(tempFilesDuringSavepointWrite(db)).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('a store open for traffic keeps the savepoint journal in memory', async () => {
    const { database } = await fileStore()
    expect(tempStore(database)).toBe(2)
    expect(tempFilesDuringSavepointWrite(database)).toEqual([])
  })

  it('the periodic statistics refresh runs with temp files on disk, then traffic resumes in memory', async () => {
    const { store, database } = await fileStore()
    const during: number[] = []
    cleanup.push(
      probeStatements(store as unknown as StatementProbeHolder, (observation) => {
        if (observation.sql === 'PRAGMA optimize') during.push(tempStore(database))
      }),
    )
    await store.refreshPlannerStatistics('periodic')
    expect(during).toEqual([1])
    expect(tempStore(database)).toBe(2)
  })
})
