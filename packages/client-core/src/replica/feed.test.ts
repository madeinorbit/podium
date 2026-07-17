/**
 * The healing ladder (ADR 2 D7), rung by rung. Every case here is a class of
 * SILENT permanent divergence — none of them throws, none of them logs, and a
 * suite that only checks entity convergence passes while they rot. That is why
 * the ladder is a pure function: the alternative is discovering rung 4 through a
 * user's stale board.
 */

import { describe, expect, it } from 'vitest'
import {
  advanceCursor,
  COLD_CURSOR,
  decideFeedAction,
  type FeedCursor,
  identityVerdict,
  isCompacted,
} from './feed'

const held = (over: Partial<FeedCursor> = {}): FeedCursor => ({
  feedId: 'feed_1',
  epoch: 'epoch_1',
  seq: 10,
  ...over,
})
const stamp = { feedId: 'feed_1', epoch: 'epoch_1' }

describe('identityVerdict — equality only, three-valued (ADR 2 D1)', () => {
  it('agrees when both sides state the same identity', () => {
    expect(identityVerdict(held(), stamp)).toBe('match')
  })

  it('a cold client has nothing to compare — unknown, NOT mismatch', () => {
    // The distinction is load-bearing: a cold client treated as mismatched
    // would discard-and-rebootstrap on its very first frame, forever.
    expect(identityVerdict(COLD_CURSOR, stamp)).toBe('unknown')
  })

  it('a pre-identity authority stamps nothing — unknown, NOT mismatch', () => {
    // An authority that predates POD-792 cannot be caught lying about an
    // identity it never states. Refusing to sync with it is a regression, not a
    // safety property.
    expect(identityVerdict(held(), {})).toBe('unknown')
  })

  it('a DIFFERENT epoch on the same feed is a mismatch — the restore-from-backup case', () => {
    expect(identityVerdict(held(), { ...stamp, epoch: 'epoch_2' })).toBe('mismatch')
  })

  it('a different feedId is a mismatch even when the epoch matches', () => {
    expect(identityVerdict(held(), { feedId: 'feed_2', epoch: 'epoch_1' })).toBe('mismatch')
  })

  it('a mismatch on ONE id is a mismatch even when the other is unknown', () => {
    expect(identityVerdict({ feedId: 'feed_1', epoch: null }, { feedId: 'feed_2' })).toBe(
      'mismatch',
    )
  })
})

describe('isCompacted — the authority publishes what it can serve (ADR 2 D5)', () => {
  it('serves when every change after the cursor is retained', () => {
    // minAvailableSeq 11 means (10, max] is retained: cursor 10 IS servable.
    expect(isCompacted(10, 11)).toBe(false)
  })

  it('is compacted when the change after the cursor is already pruned', () => {
    expect(isCompacted(10, 12)).toBe(true)
  })

  it('a cold cursor is never compacted — it is a bootstrap either way', () => {
    expect(isCompacted(0, 500)).toBe(false)
  })

  it('an authority that publishes nothing cannot be judged compacted', () => {
    expect(isCompacted(10, undefined)).toBe(false)
  })
})

describe('decideFeedAction — the ladder', () => {
  it('rung 0: contiguous delta on the held identity applies', () => {
    const action = decideFeedAction(held(), {
      kind: 'delta',
      firstSeq: 11,
      cursor: 13,
      stamp,
    })
    expect(action).toEqual({ rung: 0, effect: 'apply' })
  })

  it('rung 1: a gap heals via changesSince — it does NOT apply', () => {
    const action = decideFeedAction(held(), { kind: 'delta', firstSeq: 13, cursor: 15, stamp })
    expect(action).toEqual({ rung: 1, effect: 'heal', reason: 'gap' })
  })

  it('rung 2: compacted re-bootstraps BEFORE asking, never heals', () => {
    // Healing here is the sideways resolution D7 forbids: changesSince cannot
    // answer a cursor the authority pruned, so the heal would fail and retry
    // against the same wall forever.
    const action = decideFeedAction(held(), {
      kind: 'delta',
      firstSeq: 40,
      cursor: 41,
      stamp: { ...stamp, minAvailableSeq: 30 },
    })
    expect(action).toEqual({ rung: 2, effect: 'rebootstrap', reason: 'compacted' })
  })

  it('rung 2 outranks rung 1: a gap we cannot heal is not a gap', () => {
    // Both conditions hold (seq 40 != 11, and we are pruned past). Were the gap
    // rule to win, the client would ask changesSince(10) forever.
    const action = decideFeedAction(held(), {
      kind: 'delta',
      firstSeq: 40,
      cursor: 41,
      stamp: { ...stamp, minAvailableSeq: 30 },
    })
    expect(action.effect).toBe('rebootstrap')
  })

  it('rung 3: a delta whose last seq precedes its first is malformed', () => {
    const action = decideFeedAction(held(), { kind: 'delta', firstSeq: 11, cursor: 10, stamp })
    expect(action).toEqual({ rung: 3, effect: 'rebootstrap', reason: 'malformed' })
  })

  it('rung 3: an EMPTY delta that moves the cursor is malformed — it must not advance', () => {
    // Protocol law (sync.ts #247 round 3): an empty delta claiming a later
    // cursor would make us skip every change between forever.
    const action = decideFeedAction(held(), { kind: 'delta', cursor: 20, stamp })
    expect(action).toEqual({ rung: 3, effect: 'rebootstrap', reason: 'malformed' })
  })

  it('an empty delta AT the cursor is a legitimate no-op', () => {
    const action = decideFeedAction(held(), { kind: 'delta', cursor: 10, stamp })
    expect(action).toEqual({ rung: 0, effect: 'skip', reason: 'stale' })
  })

  it('rung 4: an epoch bump discards — it is not a gap, however contiguous it looks', () => {
    // THE D1 case. seq 11 IS cursor+1, so every seq-only check on earth says
    // "apply". It is a different timeline and the rows are phantoms.
    const action = decideFeedAction(held(), {
      kind: 'delta',
      firstSeq: 11,
      cursor: 11,
      stamp: { feedId: 'feed_1', epoch: 'epoch_2' },
    })
    expect(action).toEqual({ rung: 4, effect: 'discard', reason: 'epoch-mismatch' })
  })

  it('rung 4 outranks EVERY other rung, including a snapshot', () => {
    // Identity is judged before contiguity because a seq is only meaningful
    // within a generation. This is the ordering the whole of D1 exists for.
    for (const event of [
      { kind: 'delta', firstSeq: 11, cursor: 12, stamp: { epoch: 'epoch_2' } },
      { kind: 'delta', firstSeq: 99, cursor: 99, stamp: { epoch: 'epoch_2', minAvailableSeq: 90 } },
    ] as const) {
      expect(decideFeedAction(held(), event).rung).toBe(4)
    }
  })

  it('a replayed batch is skipped, not healed — a reconnect must not storm', () => {
    const action = decideFeedAction(held(), { kind: 'delta', firstSeq: 5, cursor: 9, stamp })
    expect(action).toEqual({ rung: 0, effect: 'skip', reason: 'stale' })
  })

  it('a cold client applies a snapshot from an authority it has never met', () => {
    const action = decideFeedAction(COLD_CURSOR, { kind: 'snapshot', cursor: 77, stamp })
    expect(action).toEqual({ rung: 0, effect: 'apply' })
  })

  it('a pre-identity authority still syncs — unknown identity is not a mismatch', () => {
    const action = decideFeedAction(held(), { kind: 'delta', firstSeq: 11, cursor: 11, stamp: {} })
    expect(action).toEqual({ rung: 0, effect: 'apply' })
  })
})

describe('advanceCursor', () => {
  it('takes the stamped identity and the event cursor', () => {
    expect(advanceCursor(COLD_CURSOR, { kind: 'snapshot', cursor: 77, stamp })).toEqual({
      feedId: 'feed_1',
      epoch: 'epoch_1',
      seq: 77,
    })
  })

  it('an unstamped reply must NOT blank an identity we already established', () => {
    // Otherwise a mixed-version authority (one node stamps, one does not) would
    // blank the identity on every unstamped reply and read the next stamped one
    // as a rung-4 mismatch against nothing: a permanent reset loop.
    expect(advanceCursor(held(), { kind: 'delta', firstSeq: 11, cursor: 11, stamp: {} })).toEqual({
      feedId: 'feed_1',
      epoch: 'epoch_1',
      seq: 11,
    })
  })
})
