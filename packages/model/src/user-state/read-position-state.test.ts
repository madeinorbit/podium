/**
 * The event-stream read cursor as a family member (POD-1380): the closed stream
 * vocabulary, the monotonic rule, the composite row id, and the family totality
 * claim that a new member has to move.
 */

import { describe, expect, it } from 'vitest'
import { PER_USER_STATE_FAMILY } from './family'
import {
  advanceReadPosition,
  READ_STREAM_IDS,
  ReadPositionState,
  ReadPositionWire,
  readPositionRowId,
  isReadStreamId,
  parseReadPositionRowId,
} from './read-position-state'

const ALICE = 'user:alice'
const BOB = 'user:bob'

describe('the closed stream vocabulary', () => {
  it('admits the issue-event log and refuses anything else', () => {
    expect(isReadStreamId('issueEvents')).toBe(true)
    expect(isReadStreamId('issueevents')).toBe(false)
    expect(isReadStreamId('')).toBe(false)
    expect(isReadStreamId('../../etc/passwd')).toBe(false)
    expect([...READ_STREAM_IDS]).toEqual(['issueEvents'])
  })

  it('the schema refuses an unknown stream even when the command is bypassed', () => {
    expect(
      ReadPositionState.safeParse({
        userId: ALICE,
        entityId: 'issueEvents',
        lastEventId: 3,
        seenAt: null,
      }).success,
    ).toBe(true)
    const bad = ReadPositionState.safeParse({
      userId: ALICE,
      entityId: 'somethingElse',
      lastEventId: 3,
      seenAt: null,
    })
    expect(bad.success).toBe(false)
  })

  it('refuses a negative or fractional position — a log id is a whole number', () => {
    const base = { userId: ALICE, entityId: 'issueEvents', seenAt: null }
    expect(ReadPositionState.safeParse({ ...base, lastEventId: -1 }).success).toBe(false)
    expect(ReadPositionState.safeParse({ ...base, lastEventId: 1.5 }).success).toBe(false)
    expect(ReadPositionState.safeParse({ ...base, lastEventId: 0 }).success).toBe(true)
  })

  it('the wire carries the owning user, so a foreign row is recognisable as foreign', () => {
    const parsed = ReadPositionWire.safeParse({
      userId: ALICE,
      streamId: 'issueEvents',
      lastEventId: 9,
      seenAt: null,
    })
    expect(parsed.success).toBe(true)
    expect(ReadPositionWire.safeParse({ streamId: 'issueEvents', lastEventId: 9, seenAt: null }).success).toBe(
      false,
    )
  })
})

describe('the monotonic merge rule', () => {
  it('a first position is taken as-is', () => {
    expect(advanceReadPosition(undefined, { lastEventId: 7, seenAt: 'a' })).toEqual({
      lastEventId: 7,
      seenAt: 'a',
    })
  })

  it('moves forward, and refuses to move back or sideways', () => {
    const current = { lastEventId: 50, seenAt: 'then' }
    expect(advanceReadPosition(current, { lastEventId: 51, seenAt: 'now' })).toEqual({
      lastEventId: 51,
      seenAt: 'now',
    })
    // The failure this rule exists to prevent: a stale device re-marking read
    // events unread because it wrote last.
    expect(advanceReadPosition(current, { lastEventId: 49, seenAt: 'now' })).toBeNull()
    expect(advanceReadPosition(current, { lastEventId: 50, seenAt: 'now' })).toBeNull()
  })

  it('a LATER clock cannot carry an EARLIER position — the id is the ordering', () => {
    // Explicitly the last-writer-wins case: the proposal is newer by every clock
    // and still loses, because a device clock is not an ordering over the log.
    expect(
      advanceReadPosition(
        { lastEventId: 100, seenAt: '2020-01-01T00:00:00Z' },
        { lastEventId: 2, seenAt: '2030-01-01T00:00:00Z' },
      ),
    ).toBeNull()
  })
})

describe('the composite row id', () => {
  it('round-trips', () => {
    const id = readPositionRowId(ALICE, 'issueEvents')
    expect(parseReadPositionRowId(id)).toEqual({ userId: ALICE, streamId: 'issueEvents' })
  })

  it('a userId containing the separator cannot collide with another pair', () => {
    const sneaky = `${BOB}\nissueEvents`
    expect(readPositionRowId(sneaky, 'x')).not.toBe(readPositionRowId(BOB, 'issueEvents'))
    expect(parseReadPositionRowId(readPositionRowId(sneaky, 'x'))).toEqual({
      userId: sneaky,
      streamId: 'x',
    })
  })

  it('throws on a malformed id rather than inventing a user', () => {
    expect(() => parseReadPositionRowId('no-separator')).toThrow(/malformed/)
    expect(() => parseReadPositionRowId('')).toThrow(/malformed/)
  })
})

describe('family membership', () => {
  it('the cursor is a member with its own table, and every member is keyed per user', () => {
    const member = PER_USER_STATE_FAMILY.find((m) => m.name === 'issueEventReadCursor')
    expect(member?.table).toBe('user_read_position')
    for (const m of PER_USER_STATE_FAMILY) {
      // Every member composes the ONE perUserKey fragment — the invariant the
      // family list exists to assert. A member keyed by the entity alone is the
      // shared-singleton shape this programme is removing.
      expect(Object.keys(m.schema.shape), m.name).toEqual(
        expect.arrayContaining(['userId', 'entityId']),
      )
      expect(m.table, m.name).not.toBe('')
    }
  })
})
