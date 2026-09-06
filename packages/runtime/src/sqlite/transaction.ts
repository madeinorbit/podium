/**
 * Nesting-safe SQLite transaction helper [spec:SP-3fe2].
 *
 * The outer transaction helper retained for synchronous migration and fixture code.
 * Runtime repository composition and nested spans belong to StoreExecutor.
 */

import { createLogger } from '@podium/logger'
import type { SqlTransactionScope } from './types'

const log = createLogger('runtime:sqlite')

/**
 * Outer transaction: BEGIN IMMEDIATE, COMMIT on success and ROLLBACK on throw,
 * rethrowing the original error.
 *
 * Contract for `fn`:
 * - MUST be synchronous. An async `fn` would let other work interleave with
 *   the open transaction (and commit before the work ran), so a returned
 *   thenable is rejected: the transaction rolls back and a descriptive error
 *   is thrown. Caveat: the guard fires when `fn` RETURNS — code after the
 *   first `await` inside an async fn runs later in autocommit mode and is NOT
 *   protected. Don't hand this helper async functions at all.
 * - MUST NOT manage transactions itself (no COMMIT/ROLLBACK/BEGIN). If fn commits under us, our
 *   COMMIT throws; the cleanup below is guarded so THAT original error is
 *   reported instead of being masked by the follow-up rollback failure.
 */
export function transaction<T>(db: SqlTransactionScope, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    if (isThenable(result)) {
      throw new TypeError(
        'transaction(db, fn): fn returned a thenable — async functions are not supported. ' +
          'SQLite transactions here are synchronous; awaiting inside one would interleave ' +
          'other writes into the open transaction. Make fn synchronous.',
      )
    }
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackErr) {
      log.error('transaction cleanup failed after an error', {
        err: rollbackErr,
        hint: 'the callback may have managed the transaction itself',
      })
    }
    throw err
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}
