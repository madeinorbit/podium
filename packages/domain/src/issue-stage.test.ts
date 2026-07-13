import { describe, expect, it } from 'vitest'
import {
  DEFER_NEXT_MESSAGE,
  isIssueDeferred,
  isIssueSnoozed,
  issueReturnedFromDefer,
} from './issue-stage'

const NOW_ISO = '2026-07-13T12:00:00.000Z'
const NOW = Date.parse(NOW_ISO)

describe('next-message defer sentinel', () => {
  const row = { deferUntil: DEFER_NEXT_MESSAGE }

  it('counts as deferred/snoozed in both predicate homes', () => {
    expect(isIssueDeferred(row, NOW_ISO)).toBe(true)
    expect(isIssueSnoozed(row, NOW)).toBe(true)
  })

  it('never lapses by time (no "Unsnoozed" return)', () => {
    expect(issueReturnedFromDefer(row, NOW)).toBe(false)
    expect(issueReturnedFromDefer(row, NOW + 365 * 86_400_000)).toBe(false)
  })

  it('timed defers are unaffected', () => {
    expect(isIssueSnoozed({ deferUntil: '2026-07-14' }, NOW)).toBe(true)
    expect(issueReturnedFromDefer({ deferUntil: '2026-07-01' }, NOW)).toBe(true)
    expect(isIssueSnoozed({ deferUntil: null }, NOW)).toBe(false)
    expect(isIssueDeferred({ deferUntil: null }, NOW_ISO)).toBe(false)
  })
})
