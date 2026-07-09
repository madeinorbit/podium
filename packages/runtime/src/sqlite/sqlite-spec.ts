import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './index'

export interface SqlTestPrimitives {
  describe: (name: string, fn: () => void) => void
  it: (name: string, fn: () => void | Promise<void>) => void
  // biome-ignore lint/suspicious/noExplicitAny: runner-neutral primitive (vitest/bun expect)
  expect: (actual: unknown) => any
}

let counter = 0
function tmpDbPath(): string {
  counter += 1
  return join(tmpdir(), `podium-sqlite-spec-${process.pid}-${counter}.db`)
}

/**
 * Shared SQLite-shim behaviors, run against whichever runtime driver is active
 * (node:sqlite under vitest/Node, bun:sqlite under `bun test`). The shim must behave
 * identically on both — that is the whole point of the abstraction.
 */
export function sqliteShimSpec(t: SqlTestPrimitives): void {
  const { describe, it, expect } = t

  describe(`sqlite shim [${process.versions.bun ? 'bun:sqlite' : 'node:sqlite'}]`, () => {
    it('round-trips rows with positional ? params (prepare/run/all)', () => {
      const db = openDatabase(':memory:')
      try {
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT NOT NULL, v INTEGER)')
        db.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', 1)
        db.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('b', 2)
        const rows = db.prepare('SELECT k, v FROM t ORDER BY id').all() as {
          k: string
          v: number
        }[]
        expect(rows).toEqual([
          { k: 'a', v: 1 },
          { k: 'b', v: 2 },
        ])
      } finally {
        db.close()
      }
    })

    it('get() returns a row, or undefined when there is none', () => {
      const db = openDatabase(':memory:')
      try {
        db.exec('CREATE TABLE t (k TEXT, v INTEGER)')
        db.prepare('INSERT INTO t VALUES (?, ?)').run('x', 9)
        const hit = db.prepare('SELECT v FROM t WHERE k = ?').get('x') as { v: number } | undefined
        const miss = db.prepare('SELECT v FROM t WHERE k = ?').get('nope')
        expect(hit?.v).toBe(9)
        expect(miss).toBe(undefined)
      } finally {
        db.close()
      }
    })

    it('run() reports changes and lastInsertRowid', () => {
      const db = openDatabase(':memory:')
      try {
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT)')
        const r1 = db.prepare('INSERT INTO t (k) VALUES (?)').run('a')
        const r2 = db.prepare('INSERT INTO t (k) VALUES (?)').run('b')
        expect(Number(r1.changes)).toBe(1)
        expect(Number(r1.lastInsertRowid)).toBe(1)
        expect(Number(r2.lastInsertRowid)).toBe(2)
      } finally {
        db.close()
      }
    })

    it('commits and rolls back transactions via exec', () => {
      const db = openDatabase(':memory:')
      try {
        db.exec('CREATE TABLE t (v INTEGER)')
        db.exec('BEGIN IMMEDIATE')
        db.prepare('INSERT INTO t VALUES (?)').run(1)
        db.exec('COMMIT')
        db.exec('BEGIN IMMEDIATE')
        db.prepare('INSERT INTO t VALUES (?)').run(2)
        db.exec('ROLLBACK')
        const rows = db.prepare('SELECT v FROM t').all() as { v: number }[]
        expect(rows).toEqual([{ v: 1 }])
      } finally {
        db.close()
      }
    })

    it('accepts PRAGMA via exec', () => {
      const path = tmpDbPath()
      const db = openDatabase(path)
      try {
        // Must not throw on a real file (WAL is a no-op for :memory:).
        db.exec('PRAGMA journal_mode = WAL')
        db.exec('PRAGMA busy_timeout = 5000')
        db.exec('CREATE TABLE t (v INTEGER)')
        db.prepare('INSERT INTO t VALUES (?)').run(7)
        expect((db.prepare('SELECT v FROM t').get() as { v: number }).v).toBe(7)
      } finally {
        db.close()
      }
    })

    it('opens read-only and rejects writes', () => {
      const path = tmpDbPath()
      const seed = openDatabase(path)
      seed.exec('CREATE TABLE t (v INTEGER)')
      seed.prepare('INSERT INTO t VALUES (?)').run(42)
      seed.close()

      const ro = openDatabase(path, { readOnly: true })
      try {
        const row = ro.prepare('SELECT v FROM t').get() as { v: number }
        expect(row.v).toBe(42)
        let threw = false
        try {
          ro.prepare('INSERT INTO t VALUES (?)').run(1)
        } catch {
          threw = true
        }
        expect(threw).toBe(true)
      } finally {
        ro.close()
      }
    })
  })
}
