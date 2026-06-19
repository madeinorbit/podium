import { describe, expect, it } from 'vitest'
import { agentLabel, formatReset, percentTone, statusNote } from './quota'

const now = Date.parse('2026-06-19T18:00:00.000Z')

describe('formatReset', () => {
  it('renders m / h m / d h, and edge cases', () => {
    expect(formatReset(new Date(now + 40 * 60_000).toISOString(), now)).toBe('resets in 40m')
    expect(formatReset(new Date(now + 134 * 60_000).toISOString(), now)).toBe('resets in 2h 14m')
    expect(formatReset(new Date(now + (28 * 60 + 5) * 60_000).toISOString(), now)).toBe('resets in 1d 4h')
    expect(formatReset(new Date(now - 5_000).toISOString(), now)).toBe('resetting…')
    expect(formatReset('', now)).toBe('')
  })
})

describe('percentTone', () => {
  it('buckets at 75 and 90', () => {
    expect(percentTone(74)).toBe('ok')
    expect(percentTone(75)).toBe('warn')
    expect(percentTone(90)).toBe('warn')
    expect(percentTone(90.1)).toBe('crit')
  })
})

describe('agentLabel / statusNote', () => {
  it('labels known agents and notes non-ok statuses', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code')
    expect(agentLabel('codex')).toBe('Codex')
    expect(statusNote({ agent: 'codex', status: 'unauthenticated', windows: [], fetchedAt: '' })).toBe('Not signed in')
    expect(statusNote({ agent: 'codex', status: 'ok', windows: [], fetchedAt: '' })).toBe('')
  })
})
