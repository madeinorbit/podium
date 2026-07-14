import { describe, expect, it } from 'vitest'
import { cronFromFields, cronSummary, formatTime, isValidCronExpression } from './cron-format'

describe('cronFromFields', () => {
  it('builds the expressions the composer offers', () => {
    expect(cronFromFields('hourly', '09:00', 1, '')).toBe('0 * * * *')
    expect(cronFromFields('daily', '09:00', 1, '')).toBe('0 9 * * *')
    expect(cronFromFields('daily', '04:30', 1, '')).toBe('30 4 * * *')
    expect(cronFromFields('weekly', '09:00', 1, '')).toBe('0 9 * * 1')
    expect(cronFromFields('weekly', '04:00', 0, '')).toBe('0 4 * * 0')
    expect(cronFromFields('cron', '09:00', 1, '*/30 * * * *')).toBe('*/30 * * * *')
  })

  it('does NOT fall back to `* * * * *` on an empty custom cron (#470)', () => {
    // The old fallback was harmless when the tab was a mock. Now every fire spawns a
    // real agent session, so an untouched cron box must produce an INVALID (empty)
    // expression that keeps Create disabled — not a schedule firing every minute.
    expect(cronFromFields('cron', '09:00', 1, '')).toBe('')
    expect(cronFromFields('cron', '09:00', 1, '   ')).toBe('')
    expect(isValidCronExpression(cronFromFields('cron', '09:00', 1, ''))).toBe(false)
  })
})

describe('isValidCronExpression', () => {
  it('accepts everything the composer can build, plus hand-written cron', () => {
    for (const expr of ['0 * * * *', '0 9 * * *', '30 4 * * 0', '*/30 * * * *', '0 8-18/4 * * 1-5'])
      expect(isValidCronExpression(expr)).toBe(true)
  })

  it('rejects the empty box and malformed expressions — the Create gate', () => {
    for (const expr of [
      '', // the footgun: an untouched custom-cron box
      '   ',
      '0 9 * *', // 4 fields
      '0 9 * * * *', // 6 fields
      '60 * * * *', // minute out of range
      '0 24 * * *', // hour out of range
      '0 0 0 * *', // day-of-month out of range
      '0 0 * 13 *', // month out of range
      '0 0 * * 8', // day-of-week out of range
      '0 0 * * mon', // names are not supported (nor by the server parser)
      '*/0 * * * *', // zero step
      '9-5 * * * *', // inverted range
      'nonsense',
    ])
      expect(isValidCronExpression(expr)).toBe(false)
  })
})

describe('cronSummary', () => {
  it('reads back the composer shapes as English, round-tripping cronFromFields', () => {
    expect(cronSummary(cronFromFields('hourly', '09:00', 1, ''))).toBe('Hourly, on the hour')
    expect(cronSummary(cronFromFields('daily', '09:00', 1, ''))).toBe('Daily at 09:00')
    expect(cronSummary(cronFromFields('weekly', '04:30', 0, ''))).toBe('Weekly on Sunday at 04:30')
  })

  it('shows anything hand-written as the raw expression', () => {
    expect(cronSummary('*/30 * * * *')).toBe('Cron: */30 * * * *')
    expect(cronSummary('0 0 1 * *')).toBe('Cron: 0 0 1 * *')
    expect(cronSummary('garbage')).toBe('garbage')
  })
})

describe('formatTime', () => {
  it('renders a null/absent/corrupt timestamp as a dash, never "Invalid Date"', () => {
    expect(formatTime(null)).toBe('—')
    expect(formatTime(undefined)).toBe('—')
    expect(formatTime('not a date')).toBe('—')
    expect(formatTime(new Date(2026, 6, 14, 9, 0).toISOString())).not.toBe('—')
  })
})
