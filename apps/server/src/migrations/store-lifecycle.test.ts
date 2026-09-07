import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from './index'
import { withMigrationForeignKeysDisabled } from './store-lifecycle'

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
