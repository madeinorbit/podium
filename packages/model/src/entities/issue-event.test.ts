import { describe, expect, it } from 'vitest'
import {
  FEED_EVENT_KINDS,
  isFeedEventKind,
  issueEventRowId,
  parseIssueEventRowId,
} from './issue-event'

/**
 * The row id is a VISIBILITY input (POD-1772): the feed's scoping decision reads
 * the subject issue out of it without touching the events table. So what is
 * asserted here is that the subject survives the round trip intact — including
 * the separator and the escape character themselves — and that a malformed id
 * is refused rather than silently parsed into some other issue's id.
 */
describe('issueEventRowId', () => {
  it('round-trips an ordinary id', () => {
    const id = issueEventRowId(42, 'POD-13')
    expect(parseIssueEventRowId(id)).toEqual({ eventId: 42, subject: 'POD-13' })
  })

  it('round-trips a subject containing the separator and the escape', () => {
    const subject = 'weird\\subject\nwith separators'
    const id = issueEventRowId(7, subject)
    expect(parseIssueEventRowId(id)).toEqual({ eventId: 7, subject })
  })

  it('cannot collide two different pairs', () => {
    expect(issueEventRowId(1, 'a\nb')).not.toBe(issueEventRowId(1, 'a') + '\nb')
  })

  it.each([
    ['no separator', '42'],
    ['empty subject', '42\n'],
    ['non-numeric event id', 'x\nPOD-13'],
    ['zero event id', '0\nPOD-13'],
    ['dangling escape', '42\nPOD\\-13'],
  ])('refuses a malformed id (%s)', (_label, id) => {
    expect(() => parseIssueEventRowId(id)).toThrow()
  })
})

describe('the feed vocabulary', () => {
  it('is closed', () => {
    expect(isFeedEventKind('issue.closed')).toBe(true)
    // A real event kind the log carries and the feed deliberately does not:
    // publishing every orchestrator breadcrumb would put a firehose in every
    // client's durable replica.
    expect(isFeedEventKind('issue.mailSent')).toBe(false)
    expect(isFeedEventKind('')).toBe(false)
  })

  it('names only issue subjects, so the visibility rule is total', () => {
    for (const kind of FEED_EVENT_KINDS) expect(kind.startsWith('issue.')).toBe(true)
  })
})
