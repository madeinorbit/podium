/**
 * THE `expo-sqlite` SHIM, exercised over a REAL SQLite engine.
 *
 * `fromExpoSqlite` is the one place this adapter names the concrete driver ADR 6 D1
 * left to POD-375. It could easily have been the weakest thing in the directory: a
 * mapping asserted against a hand-written fake that records method calls proves the
 * SHAPE and nothing about behaviour, and this run's dominant defect is exactly that —
 * a gate certifying its own fixture.
 *
 * So the fixture here is a FACADE, not a fake. It wears expo's method names
 * (`prepareSync` / `executeSync` / `getAllSync` / `getFirstSync` / `finalizeSync` /
 * `execSync` / `closeSync`) over a real database file on a real engine. The shim is
 * then driven end to end: a store commits through it, and the rows are read back
 * through a connection of its own. If the mapping is wrong, the data does not appear.
 *
 * WHAT THIS IS STILL NOT: evidence about `expo-sqlite` itself. It is evidence that
 * the mapping is correct for a driver with expo's documented synchronous surface, and
 * that the adapter runs unmodified over that surface. Running against the real
 * package needs a device or a simulator and is not in any lane in this repo — see
 * `docs/agents/pod-375-storage-evidence.md`, which states the gap rather than letting
 * a green run here imply it was closed.
 */

import { describe, expect, it } from 'vitest'
import type {
  ExpoSqliteDatabaseLike,
  ExpoSqliteStatementLike,
  SqlDatabaseLike,
  SqlValue,
} from './sql'
import { fromExpoSqlite } from './sql'
import { SqliteSyncStore } from './store'
import { freshDatabaseFile, readDurable, sqliteEngine } from './test-support'

/**
 * A real SQLite database wearing expo's synchronous API.
 *
 * `finalizeSync` calls are counted, because the shim's contract includes releasing
 * expo's native statement handles on the throwing paths this adapter is built around
 * — and a leak there is invisible to every assertion about data.
 */
class ExpoFacade implements ExpoSqliteDatabaseLike {
  prepared = 0
  finalized = 0
  closed = false

  constructor(private readonly inner: SqlDatabaseLike) {}

  prepareSync(source: string): ExpoSqliteStatementLike {
    this.prepared += 1
    const statement = this.inner.prepare(source)
    let finalized = false
    return {
      executeSync: (params: SqlValue[] = []) => ({
        // Lazy, as expo's is: the statement does not run until a getter is called.
        getAllSync: () => statement.all(...params),
        getFirstSync: () => statement.get(...params) ?? null,
      }),
      finalizeSync: () => {
        if (finalized) throw new Error('statement finalized twice')
        finalized = true
        this.finalized += 1
      },
    }
  }

  execSync(source: string): void {
    this.inner.exec(source)
  }

  closeSync(): void {
    this.closed = true
    this.inner.close()
  }
}

describe('fromExpoSqlite — the mapping, over a real engine', () => {
  it('the facade is not the engine: the shim drives a real database file end to end', async () => {
    const { file, cleanup } = freshDatabaseFile()
    try {
      let facade: ExpoFacade | undefined
      const store = await SqliteSyncStore.open({
        openDatabase: () => {
          facade = new ExpoFacade(sqliteEngine.open(file))
          return fromExpoSqlite(facade)
        },
        deleteDatabase: () => {
          throw new Error('this case never poisons the file')
        },
        onDegraded: () => undefined,
      })

      store.viewFor('ada').cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issue',
            entityId: 'ADA-1',
            value: { via: 'expo' },
            provenance: { seq: 1 },
          },
        ],
        cursor: { feedId: 'feed', epoch: 'e1', seq: 1 },
      })
      store.close()

      // Read through a connection of its own, on the NATIVE surface. A mapping that
      // silently dropped `run` — the easiest way to get this wrong, because expo's
      // execute is lazy and a `run` that never reads its result never applies the
      // statement — leaves this empty.
      expect(readDurable(file).entities).toEqual([
        { principal: 'ada', entity: 'issue', entityId: 'ADA-1', value: { via: 'expo' } },
      ])

      // Every prepared statement was released, including on the read paths.
      expect(facade?.prepared).toBeGreaterThan(0)
      expect(facade?.finalized).toBe(facade?.prepared)
      expect(facade?.closed).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('a statement is finalized even when the execute THROWS — the leak path', () => {
    // The case the `finally` in `fromExpoSqlite` exists for, and the one the happy
    // path above cannot reach. On device this is a quota denial or a locked database:
    // precisely the paths this adapter takes most seriously.
    let finalized = 0
    const exploding: ExpoSqliteDatabaseLike = {
      prepareSync: () => ({
        executeSync: () => {
          throw new Error('SQLITE_FULL: database or disk is full')
        },
        finalizeSync: () => {
          finalized += 1
        },
      }),
      execSync: () => undefined,
      closeSync: () => undefined,
    }
    expect(() => fromExpoSqlite(exploding).prepare('INSERT INTO t VALUES (?)').run(1)).toThrow(
      /disk is full/,
    )
    expect(finalized).toBe(1)
  })

  it('`get` reports an absent row as undefined, not as expo`s null', () => {
    // The one value-level mismatch between the two surfaces, and it is load-bearing:
    // the adapter's precondition re-check reads `row?.record === undefined` to mean
    // "absent". A `null` leaking through would compare unequal to `undefined` in some
    // hands and equal in others, which is how an expectation of `'absent'` silently
    // stops being checkable.
    const empty: ExpoSqliteDatabaseLike = {
      prepareSync: () => ({
        executeSync: () => ({ getAllSync: () => [], getFirstSync: () => null }),
        finalizeSync: () => undefined,
      }),
      execSync: () => undefined,
      closeSync: () => undefined,
    }
    expect(fromExpoSqlite(empty).prepare('SELECT 1').get()).toBeUndefined()
  })
})
