/**
 * THE FAULT INSTRUMENTS, and why they wrap a REAL SQLite rather than stand in for one.
 *
 * The brief for this adapter is that crash and quota are the point, and the failure
 * mode this run has paid for eight times is a gate whose refusing arm the test
 * environment cannot produce. POD-374 found the sharpest instance of it in exactly
 * this territory: the shared conformance suite stayed GREEN under a mutant giving
 * every staged write its own transaction, because the kernel's `failNextCommit`
 * fires BEFORE the adapter's native transaction opens. So the suite cannot see
 * inside this adapter's transaction, and these instruments are what can:
 *
 *   QUOTA — a write must actually be DENIED by the engine mid-transaction, after
 *   earlier writes in the SAME transaction have already been issued to it. A denial
 *   injected before `BEGIN IMMEDIATE` never reaches the quota, and the "nothing
 *   partially applied" assertion it produces is vacuous: nothing was applied because
 *   nothing was attempted. {@link FaultySqlDatabase.denyWriteAt} injects at
 *   statement N of the live transaction, so the earlier statements are genuinely in
 *   flight and it is SQLite's own `ROLLBACK` that undoes them.
 *
 *   CRASH — a kill must destroy the process's in-memory state and leave the FILE
 *   alone. `crash` mode poisons the connection at statement N: `COMMIT` throws,
 *   `ROLLBACK` throws, everything throws. Nothing in the adapter can tidy up, which
 *   is what power loss is, and the surviving state is whatever SQLite's journal
 *   yields to the NEXT connection. That is why every assertion reads through
 *   {@link readDurable} — a connection of its own — and never through the store that
 *   was supposed to have died.
 *
 * THE ENGINE IS REAL SQLite IN BOTH LANES, and which one differs by lane, which is a
 * measurement rather than an assumption — see `environment.test.ts`:
 *
 *   | lane                                       | runtime      | engine        |
 *   |--------------------------------------------|--------------|---------------|
 *   | repo root `test:unit` (`bun --bun vitest`) | bun 1.3.14   | `bun:sqlite`  |
 *   | `packages/sync`'s own `bun run test`       | node v22.22  | `node:sqlite` |
 *
 * {@link resolveSqliteEngine} tries both and THROWS if neither is present. It never
 * falls back to an in-memory imitation, because a fake engine would make every crash
 * and quota case in this directory pass for the wrong reason — the precise shape
 * this file exists to rule out.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALL_TABLES,
  CURSOR_KEY,
  ENTITY_TABLE,
  META_TABLE,
  OUTBOX_TABLE,
} from './schema'
import type { SqlDatabaseLike, SqlStatementLike, SqlValue } from './sql'

/** A real SQLite engine, named, so a failure says which one produced it. */
export interface SqliteEngine {
  readonly name: 'bun:sqlite' | 'node:sqlite'
  open(file: string): SqlDatabaseLike
}

interface DatabaseConstructor {
  new (file: string): SqlDatabaseLike
}

/**
 * Find the real SQLite this runtime provides, or refuse.
 *
 * Refusing is the load-bearing half. A resolver that quietly returned a Map-backed
 * imitation would leave every assertion in this directory green while proving
 * nothing about transactions, rollback or durability — and `environment.test.ts`
 * pins which engine was actually found, so the day a lane loses its SQLite the
 * suites fail loudly instead of silently testing a stand-in.
 */
export async function resolveSqliteEngine(): Promise<SqliteEngine> {
  const attempts: string[] = []
  for (const [specifier, exportName] of [
    ['bun:sqlite', 'Database'],
    ['node:sqlite', 'DatabaseSync'],
  ] as const) {
    try {
      const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>
      const Database = module[exportName] as DatabaseConstructor | undefined
      if (typeof Database !== 'function') {
        attempts.push(`${specifier}: no ${exportName} export`)
        continue
      }
      return {
        name: specifier,
        open: (file) => new Database(file),
      }
    } catch (error) {
      attempts.push(`${specifier}: ${(error as Error).message}`)
    }
  }
  throw new Error(
    `no real SQLite engine in this runtime — refusing to substitute a fake (tried ${attempts.join('; ')})`,
  )
}

/** Resolved once. Every suite in this directory shares it; none of them may fake it. */
export const sqliteEngine: SqliteEngine = await resolveSqliteEngine()

/**
 * A brand-new database FILE, in its own temp directory.
 *
 * A file and not `:memory:`, deliberately. "The process died and the data survived"
 * is the claim under test in `crash.test.ts` and `lifecycle.test.ts`, and an
 * in-memory database dies WITH the connection — every crash case would pass by
 * finding nothing, which is the same shape as finding the right thing.
 */
export function freshDatabaseFile(): { file: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'podium-replica-'))
  const file = join(directory, 'replica.db')
  return {
    file,
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

/**
 * Every durable row, read through a CONNECTION OF ITS OWN.
 *
 * Deliberately not `SqliteSyncStore`'s read path. An assertion about what survived a
 * crash, made through the object that was supposed to have died, is the fixture
 * certifying itself; this opens its own connection and reads the tables directly, so
 * the adapter's mirror cannot answer for the engine.
 *
 * STRICTLY READ-ONLY, and that is not a detail. The first draft called
 * `applySchema()` first so it would tolerate a file with no tables — which made the
 * reader CREATE what it was sent to observe, and would have reported "no rows" for a
 * store that never created a table at all, indistinguishable from a store that
 * created one and wrote nothing. It also deadlocked against a crashed connection
 * still holding SQLite's write lock, which is how it was found. A missing table is
 * now reported as an absent region rather than repaired.
 *
 * Reading during a crashed connection's uncommitted transaction is what a relaunched
 * app does: SQLite's rollback journal keeps the database file at PRE until COMMIT,
 * so an independent reader sees the pre-operation snapshot without waiting for the
 * dead handle to be reaped.
 */
export function readDurable(file: string): {
  entities: { principal: string; entity: string; entityId: string; value: unknown }[]
  cursors: { principal: string; cursor: unknown }[]
  outbox: { principal: string; mutationId: string; ordinal: number; record: unknown }[]
} {
  const db = sqliteEngine.open(file)
  try {
    const present = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
          name: string
        }[]
      ).map((row) => row.name),
    )
    const empty = { entities: [], cursors: [], outbox: [] }
    for (const table of [ENTITY_TABLE, META_TABLE, OUTBOX_TABLE]) {
      // An absent table is REPORTED as an absent region, never created. See the header.
      if (!present.has(table)) return empty
    }
    const entities = (
      db
        .prepare(`SELECT principal, entity, entity_id, value FROM ${ENTITY_TABLE}`)
        .all() as { principal: string; entity: string; entity_id: string; value: string }[]
    ).map((row) => ({
      principal: row.principal,
      entity: row.entity,
      entityId: row.entity_id,
      value: JSON.parse(row.value) as unknown,
    }))
    const cursors = (
      db.prepare(`SELECT principal, value FROM ${META_TABLE} WHERE key = ?`).all(CURSOR_KEY) as {
        principal: string
        value: string
      }[]
    ).map((row) => ({ principal: row.principal, cursor: JSON.parse(row.value) as unknown }))
    const outbox = (
      db
        .prepare(
          `SELECT principal, mutation_id, ordinal, record FROM ${OUTBOX_TABLE} ORDER BY ordinal ASC`,
        )
        .all() as { principal: string; mutation_id: string; ordinal: number; record: string }[]
    ).map((row) => ({
      principal: row.principal,
      mutationId: row.mutation_id,
      ordinal: row.ordinal,
      record: JSON.parse(row.record) as unknown,
    }))
    return { entities, cursors, outbox }
  } finally {
    db.close()
  }
}

/** What SQLite reports when the device has no space left. */
export class DiskFullError extends Error {
  readonly code = 'SQLITE_FULL'
  constructor(message = 'database or disk is full') {
    super(message)
    this.name = 'SQLiteError'
  }
}

/**
 * A fault the wrapper can inject. `at` counts WRITE STATEMENTS executed through
 * `run()`, from 0, across the life of the connection.
 */
export interface WriteFault {
  /** Act on the write at this index. `0` is the first write the connection runs. */
  readonly at: number
  /**
   * `deny` refuses the write AT `at` — the quota shape, where the engine says no and
   * the adapter must roll the transaction back itself.
   *
   * `crash` lets the write at `at` through and then POISONS the connection: every
   * later statement throws, including `COMMIT` and the adapter's own `ROLLBACK`.
   * That is the power-loss shape, and it is not reachable by any `deny` index —
   * `deny` leaves a live connection that can still tidy up, while a crash leaves an
   * uncommitted transaction that only the NEXT connection resolves.
   */
  readonly mode?: 'deny' | 'crash'
  /** Defaults to a disk-full denial; a crash case passes something else so the
   *  adapter's quota branch is proven to be chosen by the ERROR and not by the
   *  injection point. */
  readonly error?: Error
}

/**
 * Wrap a database so writes can be denied or the connection killed mid-transaction.
 *
 * Faithful to what the engine does on each path: a `deny` throws from the statement
 * and leaves the transaction open for the adapter to roll back (so "nothing
 * partially applied" is an observation about SQLite's ROLLBACK, not about this
 * wrapper), and a `crash` makes every subsequent statement fail so nothing can be
 * rolled back in-process at all.
 */
export class FaultySqlDatabase implements SqlDatabaseLike {
  private fault: WriteFault | undefined
  private dead: Error | undefined
  /** Write statements passed through to the engine, all transactions. */
  writesIssued = 0
  /** Faults that fired. */
  denials = 0

  constructor(private readonly inner: SqlDatabaseLike) {}

  /** Arm the next fault. Pass `undefined` to disarm. */
  denyWriteAt(fault: WriteFault | undefined): void {
    this.fault = fault
  }

  /** True once a `crash` fault has poisoned this connection. */
  get isDead(): boolean {
    return this.dead !== undefined
  }

  prepare(sql: string): SqlStatementLike {
    this.refuseIfDead()
    const statement = this.inner.prepare(sql)
    return {
      run: (...params: SqlValue[]) => {
        this.refuseIfDead()
        const index = this.writesIssued
        this.writesIssued += 1
        const fault = this.fault
        if (fault !== undefined && fault.at === index) {
          this.fault = undefined
          this.denials += 1
          const error = fault.error ?? new DiskFullError()
          if ((fault.mode ?? 'deny') === 'deny') throw error
          // `crash`: the write LANDS, and then the connection dies. Every statement
          // after this one — including the COMMIT it was heading for — throws.
          const result = statement.run(...params)
          this.dead = error
          return result
        }
        return statement.run(...params)
      },
      get: (...params: SqlValue[]) => {
        this.refuseIfDead()
        return statement.get(...params)
      },
      all: (...params: SqlValue[]) => {
        this.refuseIfDead()
        return statement.all(...params)
      },
    }
  }

  exec(sql: string): void {
    this.refuseIfDead()
    this.inner.exec(sql)
  }

  close(): void {
    // Closing a poisoned connection is exactly what a relaunched app does to the
    // handle the OS reclaimed: SQLite releases the lock and the journal rolls the
    // uncommitted transaction back. So this must NOT refuse when dead.
    this.inner.close()
  }

  private refuseIfDead(): void {
    if (this.dead !== undefined) throw this.dead
  }
}

/** The tables a durable read spans. Re-exported so a suite need not import twice. */
export { ALL_TABLES }
