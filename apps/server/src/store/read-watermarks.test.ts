/**
 * ReadWatermarksRepository — the golden test, written BEFORE the drizzle
 * conversion and against the synchronous code [POD-3392, POD-3221 method §3,
 * Stage A checklist item 10].
 *
 * WHY IT EXISTS. The coverage census (POD-3244, lines 493-494) records both of
 * this repository's methods as NEVER EXECUTED: `getRecapWatermark` and
 * `setRecapWatermark` have no direct test and no indirect one either. Their two
 * production callers in `modules/sessions/read-toolkit.ts` are covered only
 * through a `Map`-backed fake (`read-toolkit.test.ts:65`), so nothing in the
 * tree has ever run this SQL. A conversion of an unexecuted method is a rewrite
 * with no oracle, which is why this file lands first and in its own right.
 *
 * WHAT IT PINS, and each one is a way the conversion can go wrong quietly:
 *   - ABSENT IS `null`, not `undefined` and not a throw. The caller at
 *     `read-toolkit.ts:288` reads it as `?? undefined` into an optional
 *     `since`, so a repository returning `undefined` would still typecheck and
 *     still behave — until some later caller distinguishes the two.
 *   - THE KEY IS THE PAIR `(reader, session_id)`, asserted with two principals
 *     in both directions. One reader cannot distinguish "keyed per reader" from
 *     "there happened to be only one reader", and for a read cursor that is the
 *     same class of defect the neighbouring `user-read-position.test.ts` states
 *     its own two-principal discipline for.
 *   - THE SECOND WRITE UPDATES IN PLACE. `ON CONFLICT … DO UPDATE` is the one
 *     construct here with a wrong form that passes every round-trip assertion:
 *     an `INSERT OR REPLACE` would also leave one row with the new watermark.
 *     So the row COUNT is asserted, and `updated_at` — which no repository
 *     method returns — is read off the table, because a `DO UPDATE SET` that
 *     forgot it would be invisible through the repository's own surface.
 *
 * THE CALLS ARE AWAITED though the methods are synchronous today. Awaiting a
 * non-promise is a no-op, and it is what lets this file survive B1 unchanged —
 * the same form the store's existing repository tests already use.
 */

import { asSessionId, type SessionId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ReaderRef } from '../modules/sessions/read-toolkit'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { stageASeam } from '../test-support/stage-a-seam'
import { ReadWatermarksRepository } from './read-watermarks'

const ALPHA: SessionId = asSessionId('sess_alpha')
const BETA: SessionId = asSessionId('sess_beta')
const READER: ReaderRef = asSessionId('sess_reader')
const OTHER_READER: ReaderRef = asSessionId('sess_other')

const T1 = '2026-09-04T09:00:00.000Z'
const T2 = '2026-09-04T10:30:00.000Z'

let db: SqlDatabase
let watermarks: ReadWatermarksRepository

/** Read the stored row directly: `updated_at` has no repository reader. */
function storedRow(
  reader: ReaderRef,
  sessionId: SessionId,
): { watermark: string; updated_at: string } | undefined {
  return db
    .prepare(
      'SELECT watermark, updated_at FROM recap_watermarks WHERE reader = ? AND session_id = ?',
    )
    .get(reader, sessionId) as { watermark: string; updated_at: string } | undefined
}

function rowCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM recap_watermarks').get() as { n: number }).n
}

beforeEach(() => {
  db = openMigratedTestDatabase()
  watermarks = new ReadWatermarksRepository(stageASeam(db))
})

describe('ReadWatermarksRepository', () => {
  it('a watermark never set is null, not undefined', async () => {
    const absent = await watermarks.getRecapWatermark(READER, ALPHA)

    expect(absent).toBeNull()
    // Distinguishing the two is the whole assertion: `toBeUndefined()` and
    // `toBeNull()` both pass `toBeFalsy()`, and the caller coerces one to the
    // other on the way out.
    expect(absent).not.toBeUndefined()
  })

  it('a set watermark reads back', async () => {
    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_120', T1)

    expect(await watermarks.getRecapWatermark(READER, ALPHA)).toBe('evt_120')
  })

  it('two readers of one session hold independent watermarks', async () => {
    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_120', T1)
    await watermarks.setRecapWatermark(OTHER_READER, ALPHA, 'evt_7', T1)

    expect(await watermarks.getRecapWatermark(READER, ALPHA)).toBe('evt_120')
    expect(await watermarks.getRecapWatermark(OTHER_READER, ALPHA)).toBe('evt_7')
  })

  it('one reader of two sessions holds independent watermarks', async () => {
    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_120', T1)
    await watermarks.setRecapWatermark(READER, BETA, 'evt_3', T1)

    expect(await watermarks.getRecapWatermark(READER, ALPHA)).toBe('evt_120')
    expect(await watermarks.getRecapWatermark(READER, BETA)).toBe('evt_3')
  })

  it('a non-session reader is an ordinary key', async () => {
    // `ReaderRef` is a union: a SessionId, 'operator', 'superagent', or
    // `superagent:${string}`. The column is plain text and the repository binds
    // the value as it arrives.
    await watermarks.setRecapWatermark('operator', ALPHA, 'evt_9', T1)
    await watermarks.setRecapWatermark('superagent:triage', ALPHA, 'evt_11', T1)

    expect(await watermarks.getRecapWatermark('operator', ALPHA)).toBe('evt_9')
    expect(await watermarks.getRecapWatermark('superagent:triage', ALPHA)).toBe('evt_11')
    expect(await watermarks.getRecapWatermark('superagent', ALPHA)).toBeNull()
  })

  it('setting the same pair twice UPDATES the one row, watermark and timestamp both', async () => {
    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_120', T1)
    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_450', T2)

    // One row, not two: the conflict target is the (reader, session_id) pair.
    expect(rowCount()).toBe(1)
    expect(await watermarks.getRecapWatermark(READER, ALPHA)).toBe('evt_450')
    // `updated_at` is in the `DO UPDATE SET` list and has no repository reader,
    // so a conversion that dropped it would pass every assertion above.
    expect(storedRow(READER, ALPHA)).toEqual({ watermark: 'evt_450', updated_at: T2 })
  })

  it('a second write moves only its own pair', async () => {
    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_120', T1)
    await watermarks.setRecapWatermark(OTHER_READER, ALPHA, 'evt_7', T1)

    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_450', T2)

    expect(rowCount()).toBe(2)
    expect(storedRow(OTHER_READER, ALPHA)).toEqual({ watermark: 'evt_7', updated_at: T1 })
  })

  it('a watermark may move backwards — the repository stores, it does not decide', async () => {
    // Deliberate and worth pinning: unlike `user_read_position.advance`, this
    // repository has no monotonicity rule. `recap` recomputes the cursor from
    // what it just read, and a caller re-reading an earlier range writes the
    // earlier value back. A conversion that "improved" this into a MAX() would
    // be a behaviour change.
    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_450', T1)
    await watermarks.setRecapWatermark(READER, ALPHA, 'evt_120', T2)

    expect(await watermarks.getRecapWatermark(READER, ALPHA)).toBe('evt_120')
  })
})
