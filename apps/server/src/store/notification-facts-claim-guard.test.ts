/**
 * GOLDEN TEST FOR THE ATOMIC CLAIM GUARD [POD-3395].
 *
 * `NotificationFactsRepository.claim` is the store's one `INSERT ... RETURNING`
 * — the statement POD-3318 names as the reason write intent may never be read
 * off drizzle's `method`. Its `ON CONFLICT ... DO UPDATE ... WHERE` is what
 * makes two concurrent producers unable to both win: the guard is INSIDE the
 * single write statement, so there is no read-then-write window to lose.
 *
 * The census records `claim` as directly tested. Its GUARD is not: removing the
 * conflict `WHERE` entirely leaves `modules/messages/gate-agent.test.ts` and
 * `modules/messages/service.test.ts` green — 233 tests, all passing, with a
 * claim on a live fact now succeeding. Measured, not assumed. That is exactly
 * the shape spec rule 14 describes: the happy arm never reaches the refusal, the
 * OUTCOME (a boolean) looks identical, and only the MECHANISM is gone.
 *
 * So this file walks the refusing arm. Each case pins one of the three ways the
 * guard can answer — live claim refused, retired claim re-granted, expired claim
 * re-granted — and pairs the refusal with an assertion that the stored row was
 * not overwritten, because a guard that refuses the RETURN while still applying
 * the SET would report correctly and corrupt the row.
 */

import type { IssueId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { NotificationFactsRepository } from './notification-facts'

let facts: NotificationFactsRepository

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T01:00:00.000Z'
const T2 = '2026-01-01T02:00:00.000Z'

const claim = (over: Partial<Parameters<NotificationFactsRepository['claim']>[0]> = {}) =>
  facts.claim({
    factKey: 'fact:one',
    target: 'target-a',
    source: 'first',
    issueId: null,
    createdAt: T0,
    expiresAt: null,
    ...over,
  })

beforeEach(() => {
  facts = new NotificationFactsRepository(
    createBunStoreExecutor({ database: openMigratedTestDatabase() }),
  )
})

describe('NotificationFactsRepository.claim', () => {
  it('grants a claim nobody holds', () => {
    expect(claim()).toBe(true)
    expect(facts.hasActive('fact:one', 'target-a', T1)).toBe(true)
  })

  it('refuses a second claim while the first is live', () => {
    expect(claim()).toBe(true)

    // The whole point of the guard: the loser is told it lost.
    expect(claim({ source: 'second', createdAt: T1 })).toBe(false)
  })

  it('leaves the live claim untouched when it refuses', () => {
    // The holder expires at T1. The refused claim would give it no expiry at all.
    expect(claim({ expiresAt: T1 })).toBe(true)

    expect(claim({ source: 'second', createdAt: T0, expiresAt: null })).toBe(false)

    // A guard that refuses the RETURN but still applies the SET would answer
    // false and quietly rewrite the row — same boolean, wrong state. If the SET
    // had landed, expires_at would now be NULL and this claim would read as live
    // forever.
    expect(facts.hasActive('fact:one', 'target-a', T2)).toBe(false)
  })

  it('grants the claim again once the holder has retired it', () => {
    expect(claim()).toBe(true)
    expect(facts.retire('fact:one', 'target-a', T1)).toBe(true)

    expect(claim({ source: 'second', createdAt: T2 })).toBe(true)
    expect(facts.hasActive('fact:one', 'target-a', T2)).toBe(true)
  })

  it('grants the claim again once the holder has expired', () => {
    expect(claim({ expiresAt: T1 })).toBe(true)

    // Expiry is judged against the INCOMING claim's created_at, not against a
    // clock the statement reads for itself.
    expect(claim({ source: 'second', createdAt: T2 })).toBe(true)
  })

  it('still refuses while an unexpired holder is live', () => {
    expect(claim({ expiresAt: T2 })).toBe(true)

    // The other side of the expiry comparison, so the test above cannot be
    // satisfied by a guard that treats every expires_at as past.
    expect(claim({ source: 'second', createdAt: T1 })).toBe(false)
  })

  it('keeps a claim on one target from blocking another', () => {
    expect(claim()).toBe(true)

    // The conflict target is (fact_key, target), so the same fact for a second
    // recipient is a different claim and not a conflict at all.
    expect(claim({ target: 'target-b' })).toBe(true)
  })
})
