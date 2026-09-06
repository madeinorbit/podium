/**
 * THE PREPARED LATEST-STATE STATEMENTS MUST OUTLIVE THE SPAN THEY WERE BUILT IN
 * [POD-3494].
 *
 * `SyncRepository` memoizes the `change_latest` upsert and delete so a
 * hundred-row append constructs their SQL once rather than once per row
 * (`./prepared-loop-scaling.test.ts` is that half). A drizzle prepared statement
 * binds the SESSION of the instance it was built from and keeps it forever, so
 * the memoized pair may only be prepared over the ROOT drizzle instance — where
 * ambient routing still resolves the enclosing span per execution. Prepared over
 * the span's own instance instead, the SECOND append re-entered the FIRST
 * append's frame and the executor refused it: `StaleTransactionError: transaction
 * N is closed`.
 *
 * WHY IT NEEDS THE REAL STORE. `@podium/sync`'s own fixture opens its spans with
 * drizzle's transaction rather than the executor's, and a drizzle transaction
 * object goes on serving statements after it commits — so the package's suite
 * cannot see this and stayed green while every server service test that creates
 * an issue was red. The executor's frames are what refuse a closed span, so the
 * oracle has to be a store built the way production builds one.
 *
 * TWO APPENDS, NOT ONE, and both arms in each: the bug needs a second span to
 * show, and the delete arm is a separately memoized statement with the same
 * binding.
 */

import { describe, expect, it } from 'vitest'
import { openTestStore } from '../test-support/open-test-store'

describe('memoized change_latest statements across spans', () => {
  it('serves a second append after the first append\'s transaction has closed', async () => {
    const store = await openTestStore(':memory:')

    await store.sync.appendChanges(
      [{ entity: 'issue', entityId: 'issue-1', op: 'upsert', payload: '{"v":1}' }],
      1,
    )
    // The append that used to fail: a fresh span, reaching the statement the
    // first span prepared.
    await store.sync.appendChanges(
      [{ entity: 'issue', entityId: 'issue-2', op: 'upsert', payload: '{"v":2}' }],
      2,
    )

    expect(
      (await store.sync.latestChangeStates()).map((row) => row.entityId),
    ).toEqual(['issue-1', 'issue-2'])
  })

  it('serves the delete arm from a later span too', async () => {
    const store = await openTestStore(':memory:')

    await store.sync.appendChanges(
      [
        { entity: 'issue', entityId: 'issue-1', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issue', entityId: 'issue-2', op: 'remove', payload: null },
      ],
      1,
    )
    await store.sync.appendChanges(
      [
        { entity: 'issue', entityId: 'issue-1', op: 'remove', payload: null },
        { entity: 'issue', entityId: 'issue-3', op: 'upsert', payload: '{"v":3}' },
      ],
      2,
    )

    // The removal the second span issued took effect, and the row it upserted
    // beside it is installed: both memoized statements ran on the open span.
    expect(
      (await store.sync.latestChangeStates()).map((row) => row.entityId),
    ).toEqual(['issue-3'])
  })
})
