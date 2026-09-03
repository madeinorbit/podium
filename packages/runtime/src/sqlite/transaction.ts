/**
 * Nesting-safe SQLite transaction helper [spec:SP-3fe2].
 *
 * A composability seam for the synchronous persistence layer: repository methods
 * wrap their own writes in {@link transaction}, and a caller that needs several
 * of them atomic wraps THE CALLS in one — the inner ones degrade to savepoints
 * instead of throwing "cannot start a transaction within a transaction".
 */

import { createLogger } from '@podium/logger'
import type { SqlTransactionScope } from './types'

const log = createLogger('runtime:sqlite')

/**
 * Nesting depth per database handle. Podium opens ONE shared connection per
 * process and the driver (`bun:sqlite`) is fully synchronous,
 * so a plain counter keyed by handle is sound — there is no interleaving that
 * could observe a stale depth. WeakMap so a closed/discarded handle carries no
 * bookkeeping garbage.
 */
const depths = new WeakMap<SqlTransactionScope, number>()

/**
 * Nesting-safe transaction: BEGIN IMMEDIATE at depth 0, SAVEPOINT at depth > 0.
 * COMMIT / RELEASE on success; ROLLBACK / ROLLBACK TO + RELEASE on throw,
 * rethrowing the original error.
 *
 * Contract for `fn`:
 * - MUST be synchronous. An async `fn` would let other work interleave with
 *   the open transaction (and commit before the work ran), so a returned
 *   thenable is rejected: the transaction rolls back and a descriptive error
 *   is thrown. Caveat: the guard fires when `fn` RETURNS — code after the
 *   first `await` inside an async fn runs later in autocommit mode and is NOT
 *   protected. Don't hand this helper async functions at all.
 * - MUST NOT manage transactions itself (no COMMIT/ROLLBACK/BEGIN, and no
 *   SAVEPOINT names starting with `podium_sp_`). If fn commits under us, our
 *   COMMIT throws; the cleanup below is guarded so THAT original error is
 *   reported instead of being masked by the follow-up rollback failure.
 */
export function transaction<T>(db: SqlTransactionScope, fn: () => T): T {
  const depth = depths.get(db) ?? 0
  // Namespaced savepoint per depth (podium_sp_1, podium_sp_2, ...): unique per
  // nesting level AND unlikely to collide with any savepoint a callback might
  // create itself — a collision would make ROLLBACK TO target the callback's
  // newer savepoint instead of this helper's boundary.
  const savepoint = depth > 0 ? `podium_sp_${depth}` : null
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
    // Guarded cleanup: if fn violated the contract (committed/rolled back
    // itself), these statements throw "no transaction is active" — that
    // secondary failure must not mask the original error being rethrown.
    try {
      if (savepoint) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      } else {
        db.exec('ROLLBACK')
      }
    } catch (rollbackErr) {
      log.error('transaction cleanup failed after an error', {
        err: rollbackErr,
        // The likely cause, and the one thing that tells them apart.
        hint: 'the callback may have managed the transaction itself',
      })
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
