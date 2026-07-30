import { describe, expect, it } from 'vitest'
import { toInstant } from '../clock'
import { DEFER_NEXT_MESSAGE, isIssueDeferred, issueReturnedFromDefer } from './issue-stage'

const NOW_ISO = '2026-07-13T12:00:00.000Z'
const NOW = Date.parse(NOW_ISO)

describe('next-message defer sentinel', () => {
  const row = { deferUntil: DEFER_NEXT_MESSAGE }

  it('counts as deferred', () => {
    expect(isIssueDeferred(row, NOW)).toBe(true)
  })

  it('never lapses by time (no "Unsnoozed" return)', () => {
    expect(issueReturnedFromDefer(row, NOW)).toBe(false)
    expect(issueReturnedFromDefer(row, NOW + 365 * 86_400_000)).toBe(false)
  })

  it('is not a timestamp — the clock adapter reads it as absent', () => {
    // Callers must special-case the sentinel BEFORE converting; toInstant must
    // not quietly turn it into an instant.
    expect(toInstant(DEFER_NEXT_MESSAGE)).toBeNull()
  })

  it('timed defers are unaffected', () => {
    expect(isIssueDeferred({ deferUntil: '2026-07-14' }, NOW)).toBe(true)
    expect(issueReturnedFromDefer({ deferUntil: '2026-07-01' }, NOW)).toBe(true)
    expect(isIssueDeferred({ deferUntil: null }, NOW)).toBe(false)
    expect(isIssueDeferred({}, NOW)).toBe(false)
  })
})

describe('one clock representation (POD-299)', () => {
  /**
   * The collapse this pins: there used to be an ISO-string predicate
   * (`isIssueDeferred(row, nowIso)`, lexicographic) and an epoch-ms twin
   * (`isIssueSnoozed(row, now)`) over the SAME `deferUntil` field. Only the
   * epoch form survives, because lexicographic ISO comparison is not a total
   * order over the values this field actually holds.
   */
  it('reads a bare YYYY-MM-DD defer preset and a full ISO instant the same way', () => {
    // Both spellings of "tomorrow" are deferred; both spellings of "yesterday"
    // are not. Under lexicographic ISO compare the bare date and the instant
    // sort against each other by printed digits, not by instant.
    expect(isIssueDeferred({ deferUntil: '2026-07-14' }, NOW)).toBe(true)
    expect(isIssueDeferred({ deferUntil: '2026-07-14T00:00:00.000Z' }, NOW)).toBe(true)
    expect(isIssueDeferred({ deferUntil: '2026-07-12' }, NOW)).toBe(false)
    expect(isIssueDeferred({ deferUntil: '2026-07-12T00:00:00.000Z' }, NOW)).toBe(false)
  })

  it('compares an offset-bearing instant by its instant, not its digits', () => {
    // 10:00Z, written +02:00 — BEFORE `now`, so not deferred. A string compare
    // against NOW_ISO would see '12' > '11' at the hour and call it deferred.
    const beforeNowInLocalDigits = '2026-07-13T12:00:00+02:00'
    expect(Date.parse(beforeNowInLocalDigits)).toBeLessThan(NOW)
    expect(isIssueDeferred({ deferUntil: beforeNowInLocalDigits }, NOW)).toBe(false)
    expect(issueReturnedFromDefer({ deferUntil: beforeNowInLocalDigits }, NOW)).toBe(true)
  })

  it('treats an unparseable value as no defer at all, not as the epoch', () => {
    expect(isIssueDeferred({ deferUntil: 'whenever' }, NOW)).toBe(false)
    // …and it must not read as a LAPSED defer either, which an epoch-0 fallback
    // would have done — that would float garbage rows to the top of the sidebar.
    expect(issueReturnedFromDefer({ deferUntil: 'whenever' }, NOW)).toBe(false)
  })

  it('is exclusive at the boundary: deferred means strictly in the future', () => {
    expect(isIssueDeferred({ deferUntil: NOW_ISO }, NOW)).toBe(false)
    expect(issueReturnedFromDefer({ deferUntil: NOW_ISO }, NOW)).toBe(true)
  })
})
