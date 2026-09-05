/**
 * Lock acquisition — the READ-DECIDE-WRITE contrast case [POD-3250].
 *
 * The append is a blind write: it never asks the database a question before
 * writing, so every one of its statements can travel in a batch and its cost is
 * a function of chunk count. A lock acquisition cannot. It has to read the
 * current holder, decide whether the lease is free or expired, and only then
 * write — and the decision is in the CALLER, not in the SQL, so the transaction
 * stays open across a network round trip while nothing is happening on the
 * server. That is the shape the idle budget bites hardest, and it is why this
 * table is in the slice.
 *
 * `apps/server/src/store/locks.ts:130` is the original. The condition is
 * reproduced literally: an acquisition succeeds when there is no row, or when
 * the row's lease has expired.
 */

import { and, eq } from 'drizzle-orm'
import type { DriverSession, SqlParam, Statement } from '../../executor/driver'
import type { SpikeTables } from './schema'
import type { QueryDb } from './sync-append'

export interface LockRequest {
  readonly repoId: string
  readonly name: string
  readonly holderSessionId: string
  readonly holderLabel: string
  readonly acquiredAt: string
  readonly expiresAt: string
}

export interface LockOutcome {
  readonly acquired: boolean
  /** Who holds it — the caller when `acquired`, the incumbent otherwise. */
  readonly holder: string
}

function toSqlParams(params: readonly unknown[], sqlText: string): SqlParam[] {
  return params.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean' ||
      value instanceof Uint8Array
    ) {
      return value
    }
    throw new Error(`unbindable parameter of type ${typeof value} in: ${sqlText}`)
  })
}

function statement(
  query: { toSQL(): { sql: string; params: unknown[] } },
  method: Statement['method'],
  intent: Statement['intent'],
): Statement {
  const built = query.toSQL()
  return { sql: built.sql, params: toSqlParams(built.params, built.sql), method, intent }
}

/**
 * Acquire a named lease, or report who holds it.
 *
 * THE DECISION IS IN TYPESCRIPT, deliberately, because that is what the real
 * aggregate does and what makes this the contrast case. An `INSERT … ON
 * CONFLICT … WHERE excluded.expires_at > locks.expires_at` would collapse the
 * whole thing to one statement and one round trip — and would be a different
 * program, one that cannot tell the caller who the incumbent was or run the
 * expiry rules the lock service owns. The measurement is of the shape the store
 * actually has.
 */
export async function acquireLock(
  session: DriverSession,
  db: QueryDb,
  tables: SpikeTables,
  request: LockRequest,
  now: string,
): Promise<LockOutcome> {
  const { locks } = tables
  await session.begin('write')
  try {
    const read = await session.execute(
      statement(
        db
          .select()
          .from(locks)
          .where(and(eq(locks.repoId, request.repoId), eq(locks.name, request.name))),
        'get',
        'read',
      ),
    )
    const incumbent = read.rows[0] as Record<string, unknown> | undefined

    // The round trip above has already happened and the write lock is already
    // held; every millisecond spent here is a millisecond charged to the next
    // writer, which is the whole point of measuring this path separately.
    if (incumbent !== undefined && String(incumbent.expires_at) > now) {
      await session.commit()
      return { acquired: false, holder: String(incumbent.holder_session_id) }
    }

    await session.execute(
      statement(
        db
          .insert(locks)
          .values({
            repoId: request.repoId,
            name: request.name,
            holderSessionId: request.holderSessionId,
            holderIssueId: null,
            holderLabel: request.holderLabel,
            note: null,
            acquiredAt: request.acquiredAt,
            expiresAt: request.expiresAt,
          })
          .onConflictDoUpdate({
            target: [locks.repoId, locks.name],
            set: {
              holderSessionId: request.holderSessionId,
              holderLabel: request.holderLabel,
              acquiredAt: request.acquiredAt,
              expiresAt: request.expiresAt,
            },
          }),
        'run',
        'write',
      ),
    )
    await session.commit()
    return { acquired: true, holder: request.holderSessionId }
  } catch (error) {
    await session.rollback()
    throw error
  }
}

/** Read one lock's holder, outside any decision. */
export async function readLock(
  session: DriverSession,
  db: QueryDb,
  tables: SpikeTables,
  repoId: string,
  name: string,
): Promise<string | undefined> {
  const { locks } = tables
  const result = await session.execute(
    statement(
      db
        .select()
        .from(locks)
        .where(and(eq(locks.repoId, repoId), eq(locks.name, name))),
      'get',
      'read',
    ),
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row === undefined ? undefined : String(row.holder_session_id)
}
