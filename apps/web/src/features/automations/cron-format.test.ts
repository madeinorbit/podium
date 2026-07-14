import { describe, expect, it } from 'vitest'
import { cronFromFields, cronSummary, formatTime } from './cron-format'

describe('cronFromFields', () => {
  it('builds the expressions the composer offers', () => {
    expect(cronFromFields('hourly', '09:00', 1, '')).toBe('0 * * * *')
    expect(cronFromFields('daily', '09:00', 1, '')).toBe('0 9 * * *')
    expect(cronFromFields('daily', '04:30', 1, '')).toBe('30 4 * * *')
    expect(cronFromFields('weekly', '09:00', 1, '')).toBe('0 9 * * 1')
    expect(cronFromFields('weekly', '04:00', 0, '')).toBe('0 4 * * 0')
    expect(cronFromFields('cron', '09:00', 1, '*/30 * * * *')).toBe('*/30 * * * *')
    // An empty custom cron falls back to a valid (if noisy) expression rather than
    // sending the server an empty string.
    expect(cronFromFields('cron', '09:00', 1, '')).toBe('* * * * *')
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
