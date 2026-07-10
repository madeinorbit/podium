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

    it('reports the ORIGINAL error when fn commits the transaction itself (contract violation)', () => {
      const db = freshDb()
      try {
        let thrown: unknown
        try {
          transaction(db, () => {
            db.prepare('INSERT INTO t VALUES (?)').run(9)
            db.exec('COMMIT') // violates the contract
          })
        } catch (err) {
          thrown = err
        }
        // The helper's own COMMIT failure surfaces (not the masked follow-up
        // "cannot rollback" from cleanup), and the row fn committed is durable.
        expect(String(thrown)).toMatch(/transaction|commit/i)
        expect(String(thrown)).not.toMatch(/cannot rollback/i)
        expect(values(db)).toEqual([9])
        // Depth bookkeeping recovered: the helper is usable again.
        transaction(db, () => db.prepare('INSERT INTO t VALUES (?)').run(10))
        expect(values(db)).toEqual([9, 10])
      } finally {
        db.close()
      }
    })

    it('a callback-created savepoint cannot hijack the helper boundary (namespaced names)', () => {
      const db = freshDb()
      try {
        transaction(db, () => {
          db.prepare('INSERT INTO t VALUES (?)').run(1)
          let innerThrew = false
          try {
            transaction(db, () => {
              db.exec('SAVEPOINT sp_1') // a name the helper once used at depth 1
              db.prepare('INSERT INTO t VALUES (?)').run(2)
              db.exec('RELEASE SAVEPOINT sp_1')
              throw new Error('inner fails')
            })
          } catch {
            innerThrew = true
          }
          expect(innerThrew).toBe(true)
        })
        // Inner insert rolled back to the HELPER boundary despite the callback savepoint.
        expect(values(db)).toEqual([1])
      } finally {
        db.close()
      }
    })
  })
}
