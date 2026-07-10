import { openDatabase } from './index'
import type { SqlTestPrimitives } from './sqlite-spec'
import { transaction } from './transaction'
import type { SqlDatabase } from './types'

/**
 * Shared behaviors for the nesting-safe transaction helper [spec:SP-3fe2], run
 * against whichever runtime driver is active (node:sqlite under vitest/Node,
 * bun:sqlite under `bun test`) — same split as {@link sqliteShimSpec}.
 */
export function transactionSpec(t: SqlTestPrimitives): void {
  const { describe, it, expect } = t

  function freshDb(): SqlDatabase {
    const db = openDatabase(':memory:')
    db.exec('CREATE TABLE t (v INTEGER)')
    return db
  }

  function values(db: SqlDatabase): number[] {
    return (db.prepare('SELECT v FROM t ORDER BY v').all() as { v: number }[]).map((r) => r.v)
  }

  describe(`sqlite transaction helper [${process.versions.bun ? 'bun:sqlite' : 'node:sqlite'}]`, () => {
    it('commits at depth 0 and returns the callback result', () => {
      const db = freshDb()
      try {
        const out = transaction(db, () => {
          db.prepare('INSERT INTO t VALUES (?)').run(1)
          return 'done'
        })
        expect(out).toBe('done')
        expect(values(db)).toEqual([1])
        // The transaction is closed: a new BEGIN must not throw "within a transaction".
        db.exec('BEGIN IMMEDIATE')
        db.exec('COMMIT')
      } finally {
        db.close()
      }
    })

    it('rolls back at depth 0 on throw, rethrowing the original error', () => {
      const db = freshDb()
      try {
        let caught: unknown
        try {
          transaction(db, () => {
            db.prepare('INSERT INTO t VALUES (?)').run(1)
            throw new Error('boom')
          })
        } catch (err) {
          caught = err
        }
        expect((caught as Error).message).toBe('boom')
        expect(values(db)).toEqual([])
        db.exec('BEGIN IMMEDIATE')
        db.exec('COMMIT')
      } finally {
        db.close()
      }
    })

    it('commits nested savepoints when everything succeeds', () => {
      const db = freshDb()
      try {
        transaction(db, () => {
          db.prepare('INSERT INTO t VALUES (?)').run(1)
          transaction(db, () => {
            db.prepare('INSERT INTO t VALUES (?)').run(2)
            transaction(db, () => {
              db.prepare('INSERT INTO t VALUES (?)').run(3)
            })
          })
        })
        expect(values(db)).toEqual([1, 2, 3])
      } finally {
        db.close()
      }
    })

    it('rolls back only the inner savepoint when the outer catches the throw', () => {
      const db = freshDb()
      try {
        transaction(db, () => {
          db.prepare('INSERT INTO t VALUES (?)').run(1)
          try {
            transaction(db, () => {
              db.prepare('INSERT INTO t VALUES (?)').run(2)
              throw new Error('inner boom')
            })
          } catch {
            // swallowed — the outer transaction keeps going
          }
          db.prepare('INSERT INTO t VALUES (?)').run(3)
        })
        expect(values(db)).toEqual([1, 3])
      } finally {
        db.close()
      }
    })

    it('rolls back everything when an inner throw propagates through the outer', () => {
      const db = freshDb()
      try {
        let caught: unknown
        try {
          transaction(db, () => {
            db.prepare('INSERT INTO t VALUES (?)').run(1)
            transaction(db, () => {
              db.prepare('INSERT INTO t VALUES (?)').run(2)
              throw new Error('propagates')
            })
          })
        } catch (err) {
          caught = err
        }
        expect((caught as Error).message).toBe('propagates')
        expect(values(db)).toEqual([])
        db.exec('BEGIN IMMEDIATE')
        db.exec('COMMIT')
      } finally {
        db.close()
      }
    })

    it('rejects a thenable-returning fn, rolling the transaction back', () => {
      const db = freshDb()
      try {
        let caught: unknown
        try {
          transaction(db, () => {
            db.prepare('INSERT INTO t VALUES (?)').run(1)
            // Intentionally returns a promise to exercise the thenable guard.
            return Promise.resolve()
          })
        } catch (err) {
          caught = err
        }
        expect((caught as Error).message).toContain('thenable')
        expect(values(db)).toEqual([])
        // Depth bookkeeping recovered: a fresh transaction still works.
        transaction(db, () => {
          db.prepare('INSERT INTO t VALUES (?)').run(9)
        })
        expect(values(db)).toEqual([9])
      } finally {
        db.close()
      }
    })
  })
}
