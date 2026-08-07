/**
 * UserReadPositionRepository — per-user scoping, monotonicity and the closed
 * stream vocabulary (POD-1380), against real SQLite and the real migration.
 *
 * TWO PRINCIPALS IN EVERY SCOPING ASSERTION. One actor cannot distinguish
 * "keyed per user" from "there happened to be only one user", and for a read
 * cursor that difference is a privacy defect rather than a UX one.
 */

import { asUserId, FIRST_ADMIN_USER_ID, type UserId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { UserReadPositionRepository } from './user-read-position'

const ALICE: UserId = FIRST_ADMIN_USER_ID
const BOB: UserId = asUserId('user:bob')
const AT = '2026-08-02T09:00:00.000Z'

let cursors: UserReadPositionRepository

beforeEach(() => {
  const db = openMigratedTestDatabase()
  cursors = new UserReadPositionRepository(db)
})

describe('UserReadPositionRepository', () => {
  it('two people reading one stream hold two independent positions', () => {
    cursors.advance(ALICE, 'issueEvents', { lastEventId: 90, seenAt: AT }, AT)
    cursors.advance(BOB, 'issueEvents', { lastEventId: 4, seenAt: null }, AT)

    expect(cursors.get(ALICE, 'issueEvents')).toEqual({ lastEventId: 90, seenAt: AT })
    expect(cursors.get(BOB, 'issueEvents')).toEqual({ lastEventId: 4, seenAt: null })
    expect(cursors.getSnapshot(ALICE)).toEqual({ issueEvents: { lastEventId: 90, seenAt: AT } })
    expect(cursors.getSnapshot(BOB)).toEqual({ issueEvents: { lastEventId: 4, seenAt: null } })
  })

  it("one person's advance never moves another's position", () => {
    cursors.advance(BOB, 'issueEvents', { lastEventId: 4, seenAt: null }, AT)
    // Alice reads far ahead of Bob. If the row were keyed by the feed alone,
    // Bob's position would follow hers and his unread events would vanish.
    cursors.advance(ALICE, 'issueEvents', { lastEventId: 1_000, seenAt: null }, AT)

    expect(cursors.get(BOB, 'issueEvents')?.lastEventId).toBe(4)
    expect(cursors.get(ALICE, 'issueEvents')?.lastEventId).toBe(1_000)
  })

  it('a never-read stream is an ABSENT row, not a stored zero', () => {
    expect(cursors.get(ALICE, 'issueEvents')).toBeUndefined()
    expect(cursors.getSnapshot(ALICE)).toEqual({})
  })

  it('advance is monotonic: a stale proposal is a no-op, not a rewind', () => {
    expect(cursors.advance(ALICE, 'issueEvents', { lastEventId: 50, seenAt: AT }, AT)).toEqual({
      lastEventId: 50,
      seenAt: AT,
    })
    // A second device that wrote before its hydration landed.
    expect(
      cursors.advance(ALICE, 'issueEvents', { lastEventId: 20, seenAt: 'later' }, AT),
    ).toBeNull()
    expect(cursors.get(ALICE, 'issueEvents')).toEqual({ lastEventId: 50, seenAt: AT })
    // Equal is also a no-op: re-proposing the same position is not a change.
    expect(cursors.advance(ALICE, 'issueEvents', { lastEventId: 50, seenAt: 'x' }, AT)).toBeNull()
    expect(cursors.get(ALICE, 'issueEvents')?.seenAt).toBe(AT)
  })

  it('a stale proposal from one person cannot rewind — and cannot touch the other', () => {
    cursors.advance(ALICE, 'issueEvents', { lastEventId: 50, seenAt: null }, AT)
    cursors.advance(BOB, 'issueEvents', { lastEventId: 60, seenAt: null }, AT)
    expect(cursors.advance(ALICE, 'issueEvents', { lastEventId: 10, seenAt: null }, AT)).toBeNull()

    expect(cursors.get(ALICE, 'issueEvents')?.lastEventId).toBe(50)
    expect(cursors.get(BOB, 'issueEvents')?.lastEventId).toBe(60)
  })

  it('refuses a stream outside the closed vocabulary', () => {
    expect(() =>
      cursors.advance(ALICE, 'notAStream', { lastEventId: 1, seenAt: null }, AT),
    ).toThrow(/not a known event stream/)
    expect(cursors.getSnapshot(ALICE)).toEqual({})
  })

  it('a first advance for a person who has never read stores the proposal verbatim', () => {
    expect(cursors.advance(BOB, 'issueEvents', { lastEventId: 1, seenAt: AT }, AT)).toEqual({
      lastEventId: 1,
      seenAt: AT,
    })
    expect(cursors.get(BOB, 'issueEvents')).toEqual({ lastEventId: 1, seenAt: AT })
    expect(cursors.get(ALICE, 'issueEvents')).toBeUndefined()
  })
})
