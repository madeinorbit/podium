/**
 * UserReadPositionRepository — per-user scoping, monotonicity and the closed
 * stream vocabulary (POD-1380), against the real migrated schema, on both engines.
 *
 * TWO PRINCIPALS IN EVERY SCOPING ASSERTION. One actor cannot distinguish
 * "keyed per user" from "there happened to be only one user", and for a read
 * cursor that difference is a privacy defect rather than a UX one.
 */

import { asUserId, type UserId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drainedRepository } from '../test-support/drained-repository'
import { openSliceStore, type SliceStore } from '../test-support/pg-slice-tables'
import { UserReadPositionRepository } from './user-read-position'

// A person's id; these tables name no member row, and a Postgres clone seeds none.
const ALICE: UserId = asUserId('user:alice')
const BOB: UserId = asUserId('user:bob')
const AT = '2026-08-02T09:00:00.000Z'

let cursors: UserReadPositionRepository

let slice: SliceStore

// On the run's engine: SQLite on the store shard, Postgres on `server-store-pg` (POD-6983).
beforeEach(async () => {
  slice = await openSliceStore()
  cursors = drainedRepository(slice, new UserReadPositionRepository(slice.queries))
})

afterEach(async () => {
  await slice.close()
})

describe('UserReadPositionRepository', () => {
  it('two people reading one stream hold two independent positions', async () => {
    await cursors.advance(
      fixtureWriteScope(),
      ALICE,
      'issueEvents',
      { lastEventId: 90, seenAt: AT },
      AT,
    )
    await cursors.advance(
      fixtureWriteScope(),
      BOB,
      'issueEvents',
      { lastEventId: 4, seenAt: null },
      AT,
    )

    expect(await cursors.get(ALICE, 'issueEvents')).toEqual({ lastEventId: 90, seenAt: AT })
    expect(await cursors.get(BOB, 'issueEvents')).toEqual({ lastEventId: 4, seenAt: null })
    expect(await cursors.getSnapshot(ALICE)).toEqual({
      issueEvents: { lastEventId: 90, seenAt: AT },
    })
    expect(await cursors.getSnapshot(BOB)).toEqual({
      issueEvents: { lastEventId: 4, seenAt: null },
    })
  })

  it("one person's advance never moves another's position", async () => {
    await cursors.advance(
      fixtureWriteScope(),
      BOB,
      'issueEvents',
      { lastEventId: 4, seenAt: null },
      AT,
    )
    // Alice reads far ahead of Bob. If the row were keyed by the feed alone,
    // Bob's position would follow hers and his unread events would vanish.
    await cursors.advance(
      fixtureWriteScope(),
      ALICE,
      'issueEvents',
      { lastEventId: 1_000, seenAt: null },
      AT,
    )

    expect((await cursors.get(BOB, 'issueEvents'))?.lastEventId).toBe(4)
    expect((await cursors.get(ALICE, 'issueEvents'))?.lastEventId).toBe(1_000)
  })

  it('a never-read stream is an ABSENT row, not a stored zero', async () => {
    expect(await cursors.get(ALICE, 'issueEvents')).toBeUndefined()
    expect(await cursors.getSnapshot(ALICE)).toEqual({})
  })

  it('advance is monotonic: a stale proposal is a no-op, not a rewind', async () => {
    expect(
      await cursors.advance(
        fixtureWriteScope(),
        ALICE,
        'issueEvents',
        { lastEventId: 50, seenAt: AT },
        AT,
      ),
    ).toEqual({
      lastEventId: 50,
      seenAt: AT,
    })
    // A second device that wrote before its hydration landed.
    expect(
      await cursors.advance(
        fixtureWriteScope(),
        ALICE,
        'issueEvents',
        { lastEventId: 20, seenAt: 'later' },
        AT,
      ),
    ).toBeNull()
    expect(await cursors.get(ALICE, 'issueEvents')).toEqual({ lastEventId: 50, seenAt: AT })
    // Equal is also a no-op: re-proposing the same position is not a change.
    expect(
      await cursors.advance(
        fixtureWriteScope(),
        ALICE,
        'issueEvents',
        { lastEventId: 50, seenAt: 'x' },
        AT,
      ),
    ).toBeNull()
    expect((await cursors.get(ALICE, 'issueEvents'))?.seenAt).toBe(AT)
  })

  it('a stale proposal from one person cannot rewind — and cannot touch the other', async () => {
    await cursors.advance(
      fixtureWriteScope(),
      ALICE,
      'issueEvents',
      { lastEventId: 50, seenAt: null },
      AT,
    )
    await cursors.advance(
      fixtureWriteScope(),
      BOB,
      'issueEvents',
      { lastEventId: 60, seenAt: null },
      AT,
    )
    expect(
      await cursors.advance(
        fixtureWriteScope(),
        ALICE,
        'issueEvents',
        { lastEventId: 10, seenAt: null },
        AT,
      ),
    ).toBeNull()

    expect((await cursors.get(ALICE, 'issueEvents'))?.lastEventId).toBe(50)
    expect((await cursors.get(BOB, 'issueEvents'))?.lastEventId).toBe(60)
  })

  it('refuses a stream outside the closed vocabulary', async () => {
    await expect(
      cursors.advance(
        fixtureWriteScope(),
        ALICE,
        'notAStream',
        { lastEventId: 1, seenAt: null },
        AT,
      ),
    ).rejects.toThrow(/not a known event stream/)
    expect(await cursors.getSnapshot(ALICE)).toEqual({})
  })

  it('a first advance for a person who has never read stores the proposal verbatim', async () => {
    expect(
      await cursors.advance(
        fixtureWriteScope(),
        BOB,
        'issueEvents',
        { lastEventId: 1, seenAt: AT },
        AT,
      ),
    ).toEqual({
      lastEventId: 1,
      seenAt: AT,
    })
    expect(await cursors.get(BOB, 'issueEvents')).toEqual({ lastEventId: 1, seenAt: AT })
    expect(await cursors.get(ALICE, 'issueEvents')).toBeUndefined()
  })
})
