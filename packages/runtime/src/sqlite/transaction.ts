/**
 * Nesting-safe SQLite transaction helper [spec:SP-3fe2].
 *
 * A composability seam for the synchronous persistence layer: repository methods
 * wrap their own writes in {@link transaction}, and a caller that needs several
 * of them atomic wraps THE CALLS in one — the inner ones degrade to savepoints
 * instead of throwing "cannot start a transaction within a transaction".
 */

import type { SqlDatabase } from './types'

/**
 * Nesting depth per database handle. Podium opens ONE shared connection per
 * process and both drivers (`node:sqlite`, `bun:sqlite`) are fully synchronous,
 * so a plain counter keyed by handle is sound — there is no interleaving that
 * could observe a stale depth. WeakMap so a closed/discarded handle carries no
 * bookkeeping garbage.
 */
const depths = new WeakMap<SqlDatabase, number>()

/**
 * Nesting-safe transaction: BEGIN IMMEDIATE at depth 0, SAVEPOINT at depth > 0.
 * COMMIT / RELEASE on success; ROLLBACK / ROLLBACK TO + RELEASE on throw,
 * rethrowing the original error.
 *
 * `fn` must be synchronous. An async `fn` would let other work interleave with
 * the open transaction (and commit before the work ran), so a returned thenable
 * is rejected: the transaction rolls back and a descriptive error is thrown.
 */
export function transaction<T>(db: SqlDatabase, fn: () => T): T {
  const depth = depths.get(db) ?? 0
  // Unique savepoint name per depth (sp_1, sp_2, ...) so nested levels never
  // collide — releasing sp_2 must not release sp_1's work.
  const savepoint = depth > 0 ? `sp_${depth}` : null
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  depths.set(db, depth + 1)
  try {
    const result = fn()
    if (isThenable(result)) {
      throw new TypeError(
        'transaction(db, fn): fn returned a thenable — async functions are not supported. ' +
          'SQLite transactions here are synchronous; awaiting inside one would interleave ' +
          'other writes into the open transaction. Make fn synchronous.',
      )
    }
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
    return result
  } catch (err) {
    if (savepoint) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    } else {
      db.exec('ROLLBACK')
    }
    throw err
  } finally {
    if (depth === 0) depths.delete(db)
    else depths.set(db, depth)
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
